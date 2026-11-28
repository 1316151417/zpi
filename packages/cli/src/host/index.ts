import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@zpi-dev/agent";
import { type AssistantMessage, fastServiceTier, isJsonObject, type Model } from "@zpi-dev/ai";
import { builtinPlugins } from "@zpi-dev/builtin-plugins";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  type ModelRuntime,
  runSessionInput,
  type SessionEntry,
  SessionManager,
  supportedThinkingLevels,
} from "@zpi-dev/coding-agent";
import { withFastMode } from "../../../desktop/src/shared/fast-mode.ts";
import type { ModelBinding } from "../accounts/index.ts";
import { commands } from "./commands.ts";
import { DirectoryHistory, displayMessages, originalInputEntry } from "./history.ts";
import { CliResources, fileContext } from "./resources.ts";

type Binding = ModelBinding & { fast?: boolean };
interface Selection {
  binding: Binding;
  model: Model;
  runtime: ModelRuntime;
}
interface HostOptions {
  cwd: string;
  root: string;
  homeDir?: string;
  accounts: { selectModel(explicit?: string, previous?: Binding): Promise<Selection> | Selection };
  model?: string;
  effort?: string;
  ephemeral?: boolean;
  print?: boolean;
}
interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentSessionEvent) => void;
  skill?: string;
  filePaths?: string[];
  clipboardImages?: Uint8Array[];
  literal?: boolean;
}

const bindingType = "zpi.cli.model";
const initPlugin = builtinPlugins.filter((plugin) => plugin.id === "zpi.project-init");

function modelName(binding: Binding) {
  return `${binding.provider}/${binding.modelId}`;
}
function answerText(message: AssistantMessage) {
  const text = message.content.filter((part) => part.type === "text");
  const final = text.filter((part) => part.phase === "final_answer");
  return (final.length ? final : text.filter((part) => part.phase !== "commentary"))
    .map((part) => part.text)
    .join("");
}

function withSpeed(selection: Selection, fast?: boolean): Selection {
  if (fast === undefined || !fastServiceTier(selection.model)) return selection;
  return {
    ...selection,
    model: withFastMode(selection.model, fast),
    binding: { ...selection.binding, fast },
  };
}

function recordedBinding(entries: SessionEntry[]): Binding | undefined {
  const bindingIndex = entries.findLastIndex((e) => e.type === "custom" && e.customType === bindingType);
  const nativeIndex = entries.findLastIndex((e) => e.type === "model_change");
  const entry = entries[bindingIndex];
  const native = entries[nativeIndex];
  const data = entry?.type === "custom" ? entry.data : undefined;
  if (
    native?.type !== "model_change" ||
    bindingIndex < nativeIndex ||
    !isJsonObject(data) ||
    typeof data.provider !== "string" ||
    typeof data.accountId !== "string" ||
    !data.accountId ||
    typeof data.modelId !== "string" ||
    data.nativeProvider !== native.provider ||
    data.modelId !== native.modelId
  )
    return;
  return {
    provider: data.provider,
    accountId: data.accountId,
    modelId: data.modelId,
    ...(typeof data.fast === "boolean" ? { fast: data.fast } : {}),
  };
}

function validateEffort(model: Model, value: string): ThinkingLevel;
function validateEffort(model: Model, value?: string): ThinkingLevel | undefined;
function validateEffort(model: Model, value?: string): ThinkingLevel | undefined {
  if (value === undefined) return;
  const levels = supportedThinkingLevels(model);
  const choice = levels.find((level) => level === value);
  if (!choice) throw new Error(`此模型支持的推理档位为 ${levels.join(", ")}`);
  return choice;
}

interface ActiveSession {
  manager: SessionManager;
  session: AgentSession;
  selection: Selection;
  agentDir: string;
  release: () => void;
  temporary: boolean;
}

export class CliHost {
  readonly cwd: string;
  readonly homeDir: string;
  private readonly options: HostOptions;
  private readonly history: DirectoryHistory;
  private readonly resources: CliResources;
  private active?: ActiveSession;
  private draft: { model?: string; effort?: string; displayModel?: string; speed?: Binding };
  private pending?: Promise<string>;
  private controller?: AbortController;

  constructor(options: HostOptions) {
    this.options = options;
    this.cwd = realpathSync(options.cwd);
    this.homeDir = options.homeDir ?? homedir();
    this.history = new DirectoryHistory(options.root, this.cwd);
    this.resources = new CliResources(this.cwd, this.homeDir);
    this.draft = { model: options.model, effort: options.effort };
  }

  listHistory() {
    return this.history.list();
  }
  listSkills() {
    return this.resources.listSkills();
  }
  listCommands() {
    return this.resources.listCommands(Boolean(this.options.print ?? this.options.ephemeral));
  }
  getContext() {
    return this.active?.session.getContextUsage();
  }
  getMessages() {
    return this.active ? Array.from(displayMessages(this.active.manager.iterateEntries())) : [];
  }
  async rename(name: string) {
    this.checkIdle();
    if (!this.active) throw new Error("先发送一条消息，再给会话命名。");
    if (!name.trim() || /[\p{C}]/u.test(name) || name.length > 100)
      throw new Error("请用 /rename 名称，输入 1 至 100 个字符的单行名称。");
    this.active.session.setSessionName(name);
    await this.active.manager.flushAsync();
  }
  lastAnswer(nth = 1) {
    const messages = this.getMessages();
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role === "assistant") {
        const answer = answerText(message);
        if (answer && --nth === 0) return answer;
      }
    }
    return "";
  }

  getSelection() {
    const tier = this.active?.selection.model.samplingParams?.service_tier;
    return {
      model: this.active
        ? modelName(this.active.selection.binding)
        : (this.draft.displayModel ?? this.draft.model),
      effort: this.active?.session.thinkingLevel ?? this.draft.effort,
      fast: this.active ? tier === "priority" || tier === "fast" : this.draft.speed?.fast === true,
    };
  }

  private checkIdle() {
    if (this.pending) throw new Error("请等待当前一轮结束");
  }

  private async selectDraft() {
    const selection = await this.options.accounts.selectModel(this.draft.model);
    const speed = this.draft.speed;
    return speed &&
      speed.accountId === selection.binding.accountId &&
      modelName(speed) === modelName(selection.binding)
      ? withSpeed(selection, speed.fast)
      : selection;
  }

  async toggleFast() {
    this.checkIdle();
    const selection = this.active?.selection ?? (await this.selectDraft());
    const tier = fastServiceTier(selection.model);
    if (!tier) throw new Error("当前模型未提供加速档位。");
    const next = withSpeed(selection, selection.model.samplingParams?.service_tier !== tier);
    if (this.active) {
      await this.persistBinding(this.active.manager, next);
      await this.active.session.setModel(next.model);
      this.active.selection = next;
    } else {
      this.draft.speed = next.binding;
      this.draft.displayModel = modelName(next.binding);
    }
  }

  async getEfforts() {
    return supportedThinkingLevels((this.active?.selection ?? (await this.selectDraft())).model);
  }

  async setEffort(level: string) {
    this.checkIdle();
    const selection = this.active?.selection ?? (await this.selectDraft());
    const effort = validateEffort(selection.model, level);
    if (this.active) {
      this.active.session.setThinkingLevel(effort);
      await this.active.manager.flushAsync();
    } else {
      this.draft.displayModel = modelName(selection.binding);
      this.draft.effort = effort;
    }
  }

  async setModel(name: string) {
    this.checkIdle();
    const selection = await this.options.accounts.selectModel(name);
    if (!this.active) {
      this.draft.model = name;
      this.draft.speed = undefined;
      this.draft.displayModel = modelName(selection.binding);
      if (this.draft.effort && !supportedThinkingLevels(selection.model).some((v) => v === this.draft.effort))
        this.draft.effort = undefined;
      return;
    }
    const old = this.active;
    try {
      const session = await this.create(old.manager, old.agentDir, selection);
      old.session.dispose();
      this.active = { ...old, selection, session };
    } catch (error) {
      // The original runtime can serve another turn only with its own durable billing identity.
      try {
        await this.persistBinding(old.manager, old.selection);
      } catch {
        await this.disposeActive();
      }
      throw error;
    }
  }

  private async create(
    manager: SessionManager,
    agentDir: string,
    selection: Selection,
    effort?: ThinkingLevel,
  ) {
    const { model, runtime } = selection;
    await this.persistBinding(manager, selection);
    return (
      await createAgentSession({
        cwd: this.cwd,
        homeDir: this.options.homeDir,
        agentDir,
        sessionManager: manager,
        model,
        modelRuntime: runtime,
        resourceLoader: this.resources.loader,
        thinkingLevel: effort,
        plugins: initPlugin,
      })
    ).session;
  }

  private async persistBinding(manager: SessionManager, selection: Selection) {
    // Persist both sides of the association before the native session can warm up a model request.
    const { binding, model } = selection;
    const previous = recordedBinding(manager.getEntries());
    const state = manager.getCurrentState();
    if (state.model?.provider !== model.provider || state.model?.modelId !== model.id)
      manager.appendModelChange(model.provider, model.id);
    if (
      previous?.accountId !== binding.accountId ||
      previous.provider !== binding.provider ||
      previous.modelId !== binding.modelId ||
      previous.fast !== binding.fast ||
      state.model?.provider !== model.provider
    ) {
      await manager.appendCustomEntryAsync(bindingType, { ...binding, nativeProvider: model.provider });
      await manager.flushAsync();
    }
  }

  async resumeLatest() {
    const [item] = await this.history.list({ latestOnly: true });
    if (!item || item.error) throw new Error(item?.error ?? "当前目录没有可继续的 CLI 会话");
    await this.resumeSession(item.id, true);
  }

  resume(id: string) {
    return this.resumeSession(id, false);
  }

  private async resumeSession(id: string, alreadyPreviewed: boolean) {
    this.checkIdle();
    if (this.active?.manager.getSessionId() === id) return;
    const path = this.history.path(id);
    if (!alreadyPreviewed) await this.history.readForResume(id);
    const release = await this.history.acquire(id);
    try {
      // Re-read under the writer lock even when the chooser just previewed the same file.
      const entries = await this.history.readForResume(id);
      const explicit = this.draft.model;
      const recorded = explicit ? undefined : recordedBinding(entries);
      if (!explicit && !recorded)
        throw new Error("会话缺少完整的模型和账户绑定，请用 -m <provider/model> 明确选择");
      const selection = withSpeed(
        await this.options.accounts.selectModel(explicit, recorded),
        recorded?.fast,
      );
      const effort = validateEffort(selection.model, this.draft.effort);
      const manager = SessionManager.open(path);
      const session = await this.create(manager, this.history.directory, selection, effort);
      await this.disposeActive();
      this.active = {
        session,
        manager,
        selection,
        agentDir: this.history.directory,
        release,
        temporary: false,
      };
      this.draft = {};
    } catch (error) {
      release();
      throw error;
    }
  }

  private async start(selection: Selection, effort: ThinkingLevel | undefined) {
    const temporary = Boolean(this.options.ephemeral);
    const agentDir = temporary ? await mkdtemp(join(tmpdir(), "zpi-cli-")) : this.history.directory;
    const id = randomUUID();
    const release = temporary ? () => {} : await this.history.acquire(id);
    let manager: SessionManager | undefined;
    try {
      manager = temporary
        ? SessionManager.inMemory(this.cwd, { id })
        : SessionManager.create(this.cwd, join(agentDir, "sessions"), { id });
      const session = await this.create(manager, agentDir, selection, effort);
      this.active = { manager, session, selection, agentDir, release, temporary };
      this.draft = {};
    } catch (error) {
      try {
        if (temporary) await rm(agentDir, { recursive: true, force: true });
        else if (manager) await rm(this.history.path(id), { force: true });
      } finally {
        release();
      }
      throw error;
    }
    return this.active;
  }

  async run(text: string, options: RunOptions = {}) {
    this.checkIdle();
    this.controller = new AbortController();
    const signal = options.signal
      ? AbortSignal.any([this.controller.signal, options.signal])
      : this.controller.signal;
    this.pending = this.runTurn(text, options, signal);
    try {
      return await this.pending;
    } finally {
      this.pending = undefined;
      this.controller = undefined;
    }
  }

  private async runTurn(text: string, options: RunOptions, signal: AbortSignal) {
    signal.throwIfAborted();
    const control = options.literal ? "" : text.trim().toLowerCase();
    if (control === "/help")
      return [...commands, ...(await this.listCommands())]
        .map(({ name, description }) => `/${name}  ${description}`)
        .join("\n");
    if (control === "/context") {
      const usage = this.getContext();
      return usage
        ? `上下文 ${usage.estimatedTokens ?? usage.inputTokens ?? "未知"} / ${usage.contextWindow} tokens`
        : "当前会话尚无上下文";
    }
    const prepared = await this.resources.prepare(text, {
      skill: options.skill,
      literal: options.literal,
      print: this.options.print ?? this.options.ephemeral,
    });
    if (prepared.compact && !this.active) throw new Error("没有可压缩的完整对话内容");
    const context = await fileContext(this.cwd, options.filePaths, options.clipboardImages);
    if (!prepared.text.trim() && !context.images?.length && !context.fileReferences?.length)
      throw new Error("请输入问题");
    const selection = this.active?.selection ?? (await this.selectDraft());
    if (context.images?.length && !selection.model.input.includes("image"))
      throw new Error("当前模型不支持图片");
    const effort = this.active ? undefined : validateEffort(selection.model, this.draft.effort);
    await prepared.verify?.();
    signal.throwIfAborted();
    const active = this.active ?? (await this.start(selection, effort));
    const { session, manager: sessionManager } = active;
    const parsed = options.literal
      ? { kind: "prompt" as const, text: prepared.text }
      : await session.prepareInput(prepared.text, context);
    if (
      !active.temporary &&
      parsed.kind === "prompt" &&
      (parsed.text !== text || context.fileReferences?.length || context.images?.length)
    ) {
      context.inputId = randomUUID();
      await sessionManager.appendCustomEntryAsync(originalInputEntry, { inputId: context.inputId, text });
    }
    let output = "";
    const unsubscribe = session.subscribe((event) => {
      if (parsed.kind === "compact" && event.type === "command_result") output = event.message;
      if (parsed.kind === "prompt" && event.type === "message_end" && event.message.role === "assistant")
        output = answerText(event.message);
      options.onEvent?.(event);
    });
    try {
      await runSessionInput({ session, sessionManager, input: { parsed, context }, signal });
      return output;
    } finally {
      unsubscribe();
    }
  }

  private async disposeActive() {
    const active = this.active;
    if (!active) return;
    this.active = undefined;
    try {
      await active.manager.flushAsync();
    } finally {
      try {
        active.session.dispose();
        if (active.temporary) await rm(active.agentDir, { recursive: true, force: true });
        else if (!active.manager.getEntries().some((e) => e.type === "message" && e.message.role === "user"))
          await rm(this.history.path(active.manager.getSessionId()), { force: true });
      } finally {
        active.release();
      }
    }
  }

  async close() {
    this.controller?.abort();
    await this.pending?.catch(() => undefined);
    await this.disposeActive();
  }

  async clear() {
    this.checkIdle();
    await this.disposeActive();
    this.draft = {};
  }
}
