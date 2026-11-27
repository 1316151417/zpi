import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { ThinkingLevel } from "@zpi-dev/agent";
import { isJsonObject, type Model } from "@zpi-dev/ai";
import { builtinPlugins } from "@zpi-dev/builtin-plugins";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  type ModelRuntime,
  runSessionInput,
  type SessionEntry,
  SessionManager,
  SettingsManager,
  supportedThinkingLevels,
} from "@zpi-dev/coding-agent";
import type { ModelBinding as Binding } from "../accounts/index.ts";
import { commands } from "./commands.ts";
import { DirectoryHistory } from "./history.ts";
import { CliResources, fileContext } from "./resources.ts";

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
export interface RunOptions {
  signal?: AbortSignal;
  onEvent?: (event: AgentSessionEvent) => void;
  skill?: string;
  filePaths?: string[];
  literal?: boolean;
}

const bindingType = "zpi.cli.model";
const initPlugin = builtinPlugins.filter((plugin) => plugin.id === "zpi.project-init");

function recordedBinding(entries: SessionEntry[]): Binding {
  const entry = entries.findLast((e) => e.type === "custom" && e.customType === bindingType);
  const native = entries.findLast((e) => e.type === "model_change");
  const data = entry?.type === "custom" ? entry.data : undefined;
  if (
    !entry ||
    !native ||
    entries.indexOf(entry) < entries.indexOf(native) ||
    !isJsonObject(data) ||
    typeof data.provider !== "string" ||
    typeof data.accountId !== "string" ||
    !data.accountId ||
    typeof data.modelId !== "string" ||
    data.nativeProvider !== native.provider ||
    data.modelId !== native.modelId
  )
    throw new Error("会话缺少完整的模型和账户绑定，请用 -m <provider/model> 明确选择");
  return { provider: data.provider, accountId: data.accountId, modelId: data.modelId };
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
  private readonly options: HostOptions;
  private readonly history: DirectoryHistory;
  private readonly resources: CliResources;
  private active?: ActiveSession;
  private draftModel?: string;
  private draftEffort?: string;
  private draftSelection?: Selection;
  private pending?: Promise<string>;
  private controller?: AbortController;

  constructor(options: HostOptions) {
    this.options = options;
    this.cwd = realpathSync(options.cwd);
    this.history = new DirectoryHistory(options.root, this.cwd);
    this.resources = new CliResources(this.cwd, options.homeDir ?? homedir());
    this.draftModel = options.model;
    this.draftEffort = options.effort;
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
    return this.active?.session.messages ?? [];
  }

  getSelection() {
    const binding = (this.active?.selection ?? this.draftSelection)?.binding;
    return {
      model: binding ? `${binding.provider}/${binding.modelId}` : this.draftModel,
      account: binding?.accountId,
      effort: this.active?.session.thinkingLevel ?? this.draftEffort,
    };
  }

  private checkIdle() {
    if (this.pending) throw new Error("请等待当前一轮结束");
  }

  private selectDraft() {
    return this.options.accounts.selectModel(this.draftModel);
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
      this.draftSelection = selection;
      this.draftEffort = effort;
    }
  }

  async setModel(name: string) {
    this.checkIdle();
    const selection = await this.options.accounts.selectModel(name);
    if (!this.active) {
      this.draftModel = name;
      this.draftSelection = selection;
      if (this.draftEffort && !supportedThinkingLevels(selection.model).some((v) => v === this.draftEffort))
        this.draftEffort = undefined;
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
        settingsManager: SettingsManager.create(this.cwd, agentDir),
        resourceLoader: this.resources.loader,
        thinkingLevel: effort,
        plugins: initPlugin,
      })
    ).session;
  }

  private async persistBinding(manager: SessionManager, selection: Selection) {
    // Persist both sides of the association before the native session can warm up a model request.
    const { binding, model } = selection;
    let previous: Binding | undefined;
    try {
      previous = recordedBinding(manager.getEntries());
    } catch {
      /* First choice or explicit rebind. */
    }
    const state = manager.getCurrentState();
    if (state.model?.provider !== model.provider || state.model?.modelId !== model.id)
      manager.appendModelChange(model.provider, model.id);
    if (
      previous?.accountId !== binding.accountId ||
      previous.provider !== binding.provider ||
      previous.modelId !== binding.modelId ||
      state.model?.provider !== model.provider
    ) {
      await manager.appendCustomEntryAsync(bindingType, { ...binding, nativeProvider: model.provider });
      await manager.flushAsync();
    }
  }

  async resumeLatest() {
    const rows = await this.listHistory();
    const item = rows.find((r) => !r.error);
    if (!item) throw new Error(rows[0]?.error ?? "当前目录没有可继续的 CLI 会话");
    await this.resume(item.id);
  }

  async resume(id: string) {
    this.checkIdle();
    if (this.active?.manager.getSessionId() === id) return;
    const path = this.history.path(id);
    // The second check, under the lock, is authoritative even if a writer changed the file.
    const preview = await this.history.preview(id);
    if (preview.title === undefined) throw new Error("此 CLI 会话没有用户输入");
    const release = await this.history.acquire(id);
    try {
      const current = await this.history.preview(id);
      if (current.title === undefined) throw new Error("此 CLI 会话没有用户输入");
      const explicit = this.draftModel;
      const recorded = explicit ? undefined : recordedBinding(current.entries);
      const selection = await this.options.accounts.selectModel(explicit, recorded);
      const effort = validateEffort(selection.model, this.draftEffort);
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
      this.draftModel = undefined;
      this.draftEffort = undefined;
      this.draftSelection = undefined;
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
      this.draftModel = undefined;
      this.draftEffort = undefined;
      this.draftSelection = undefined;
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
    const context = await fileContext(this.cwd, options.filePaths);
    if (!prepared.text.trim() && !context.images?.length && !context.fileReferences?.length)
      throw new Error("请输入问题");
    const selection = this.active?.selection ?? (await this.selectDraft());
    if (context.images?.length && !selection.model.input.includes("image"))
      throw new Error("当前模型不支持图片");
    const effort = this.active ? undefined : validateEffort(selection.model, this.draftEffort);
    await prepared.verify?.();
    signal.throwIfAborted();
    const active = this.active ?? (await this.start(selection, effort));
    const { session, manager: sessionManager } = active;
    const parsed = options.literal
      ? { kind: "prompt" as const, text: prepared.text }
      : await session.prepareInput(prepared.text, context);
    let output = "";
    const unsubscribe = session.subscribe((event) => {
      if (parsed.kind === "compact" && event.type === "command_result") output = event.message;
      if (parsed.kind === "prompt" && event.type === "message_end" && event.message.role === "assistant") {
        const text = event.message.content.filter((part) => part.type === "text");
        const final = text.filter((part) => part.phase === "final_answer");
        output = (final.length ? final : text.filter((part) => part.phase !== "commentary"))
          .map((part) => part.text)
          .join("");
      }
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
    this.draftModel = undefined;
    this.draftEffort = undefined;
    this.draftSelection = undefined;
  }
}
