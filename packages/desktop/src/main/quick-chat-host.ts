import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  type AgentSession,
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import type { DesktopEvent, SessionView } from "zpi-ui";
import { emptySession, reduceSession, sessionViewBytes } from "zpi-ui/projection";
import type { CombinedSelection } from "../shared/bridge.ts";
import { toThinking } from "../shared/config.ts";
import type { QuickChatSnapshot } from "../shared/quick-chat.ts";
import { quickChatSelection } from "../shared/quick-chat-settings.ts";
import type { ErrorLog } from "./error-log.ts";
import { modelRuntimeConfig } from "./model-runtime-config.ts";
import { projectEvent } from "./projection.ts";
import { QuickChatAttachments, type QuickChatImages } from "./quick-chat-attachments.ts";
import { quickChatPromptTemplate } from "./quick-chat-prompt.ts";
import { recordedQuickChatWebSourceIcon } from "./quick-chat-source-icons.ts";
import type { QuickChatTrace } from "./quick-chat-timing.ts";
import type { SettingsStore } from "./storage.ts";
import { WebTools } from "./web-tools.ts";

export const QUICK_CHAT_IDLE_MS = 15 * 60 * 1000;

const allowedTools = new Set(["read", "bash", "web_search", "web_fetch"]);
interface ActiveRun {
  id: string;
  aborted: boolean;
  done: Promise<void>;
}
/** Isolated, memory-only conversation. Deliberately does not depend on SessionHost/StateStore. */
export class QuickChatHost {
  readonly cwd: string;
  private settings: SettingsStore;
  private requestFetch: typeof fetch;
  private session?: AgentSession;
  private runtime: ModelRuntime;
  private view: SessionView = emptySession(randomUUID(), "快速对话");
  private selection: CombinedSelection | null;
  private active?: ActiveRun;
  private interrupting = false;
  private resetting?: Promise<void>;
  private closed = false;
  private revision = 0;
  private listeners = new Set<(snapshot: QuickChatSnapshot) => void>();
  private notification?: ReturnType<typeof setTimeout>;
  private webTools: WebTools;
  private now: () => number;
  private lastAcceptedSend?: number;
  private lifetime = new AbortController();
  private attachments = new QuickChatAttachments();

  constructor(
    settings: SettingsStore,
    cwd: string,
    requestFetch: typeof fetch = fetch,
    now: () => number = () => performance.now(),
    errors?: ErrorLog,
  ) {
    this.now = now;
    this.settings = settings;
    this.cwd = resolve(cwd);
    this.requestFetch = requestFetch;
    this.runtime = new ModelRuntime(requestFetch, {
      onMediaProjection: errors ? (stats, context) => errors.mediaProjection(stats, context) : undefined,
    });
    this.selection = this.initialSelection();
    this.webTools = new WebTools({
      getApiKey: () => {
        if (!this.webEnabled()) throw new Error("configuration: 联网搜索已停用");
        return this.settings.getWebSearchApiKey();
      },
      requestFetch,
    });
  }
  private initialSelection(): CombinedSelection | null {
    return quickChatSelection(this.settings.get());
  }
  getSnapshot(): QuickChatSnapshot {
    return {
      revision: this.revision,
      session: structuredClone(this.view),
      settings: this.settings.get(),
      selection: this.selection ? { ...this.selection } : null,
      cwd: this.cwd,
    };
  }
  /** Called only for a user invocation, never by hidden warmup or streaming events. */
  resetIfExpired(): Promise<void> | undefined {
    if (this.resetting) return this.resetting;
    const elapsed = this.lastAcceptedSend === undefined ? 0 : this.now() - this.lastAcceptedSend;
    // A monotonic clock avoids wall-clock adjustments; injected invalid/backward clocks fail closed.
    if (!Number.isFinite(elapsed) || elapsed < QUICK_CHAT_IDLE_MS) return;
    return this.reset();
  }
  get sessionId(): string {
    return this.view.sessionId;
  }
  private attachmentSession(sessionId: string): void {
    if (this.closed || this.resetting) throw new Error("busy: 临时对话正在关闭或重置");
    if (sessionId !== this.view.sessionId) throw new Error("not_found: 图片不属于此临时对话");
  }
  async importAttachment(sessionId: string, name: string, bytes: Uint8Array) {
    this.attachmentSession(sessionId);
    return this.attachments.import(name, bytes);
  }
  readAttachment(sessionId: string, id: string) {
    this.attachmentSession(sessionId);
    return this.attachments.read(id);
  }
  removeAttachment(sessionId: string, id: string): void {
    this.attachmentSession(sessionId);
    this.attachments.remove(id);
  }
  discardDraftAttachments(): void {
    this.attachments.clearDraft();
  }
  async readWebSourceIcon(
    sessionId: string,
    runId: string,
    sourceUrl: string,
    load: (url: string, signal: AbortSignal) => Promise<string | undefined>,
  ): Promise<string | undefined> {
    if (this.closed || this.resetting) return;
    const icon = recordedQuickChatWebSourceIcon(this.view, sessionId, runId, sourceUrl);
    if (!icon) return;
    const lifetime = this.lifetime;
    const data = await load(icon, lifetime.signal);
    return !lifetime.signal.aborted && this.view.sessionId === sessionId ? data : undefined;
  }
  subscribe(listener: (snapshot: QuickChatSnapshot) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  refreshSettings(): void {
    if (this.closed) return;
    if (!this.active) this.selection = this.initialSelection();
    this.changed(true);
  }
  private changed(immediate = false): void {
    this.revision++;
    if (this.closed) return;
    if (immediate) {
      clearTimeout(this.notification);
      this.notification = undefined;
      const snapshot = this.getSnapshot();
      for (const listener of this.listeners) {
        try {
          listener(snapshot);
        } catch {
          /* UI lifetime cannot interrupt a run. */
        }
      }
    } else if (!this.notification) {
      this.notification = setTimeout(() => this.changed(true), 32);
      this.notification.unref();
    }
  }
  private emit(run: ActiveRun, event: DesktopEvent): void {
    if (this.active !== run || this.closed) return;
    this.view = reduceSession(this.view, {
      sessionId: this.view.sessionId,
      runId: run.id,
      seq: this.view.seq + 1,
      event,
    });
    this.changed(event.type === "started" || event.type === "settled");
  }
  private webEnabled(): boolean {
    const settings = this.settings.get();
    return (
      settings.capabilities.webSearch &&
      settings.webSearch.enabled &&
      settings.webSearch.hasApiKey &&
      !settings.webSearch.credentialsLocked
    );
  }
  private idle(): void {
    if (this.closed) throw new Error("busy: 快速对话已关闭");
    if (this.active || this.resetting || this.interrupting) throw new Error("busy: 请先停止当前回复");
  }
  send(text: string, attachmentIds: string[] = []): void {
    this.idle();
    const { loaded, selection, model } = this.prepareSend(text, attachmentIds);
    // Reserve synchronously, before initialization or network work can yield to another IPC call.
    const run: ActiveRun = { id: randomUUID(), aborted: false, done: Promise.resolve() };
    this.active = run;
    const now = this.now();
    this.lastAcceptedSend = Number.isFinite(now) ? now : undefined;
    this.attachments.markUsed(attachmentIds);
    this.emit(run, {
      type: "started",
      text: text.trim(),
      startedAt: Date.now(),
      modelLabel: model?.name ?? selection.modelId,
      ...(loaded.metadata.length ? { attachments: loaded.metadata } : {}),
    });
    run.done = this.execute(run, text.trim(), selection, loaded);
  }
  async sendNow(text: string, attachmentIds: string[] = []): Promise<void> {
    if (this.closed || this.resetting || this.interrupting)
      throw new Error("busy: 快速对话正在关闭、重置或发送");
    // Invalid drafts must not interrupt a valid reply. Revalidate after stopping
    // because settings and attachments can change while cancellation finishes.
    this.prepareSend(text, attachmentIds);
    const lifetime = this.lifetime;
    this.interrupting = true;
    try {
      await this.stop();
      if (lifetime.signal.aborted || this.closed || this.resetting)
        throw new Error("busy: 快速对话已关闭或重置");
      this.interrupting = false;
      this.send(text, attachmentIds);
    } finally {
      this.interrupting = false;
    }
  }
  private prepareSend(text: string, attachmentIds: string[]) {
    const loaded = this.attachments.load(attachmentIds);
    if (typeof text !== "string" || (!text.trim() && !loaded.images.length) || text.length > 32_000)
      throw new Error("invalid_input: 消息需为 1–32000 个字符或包含图片");
    if (this.view.runs.length >= 100 || sessionViewBytes(this.view) > 8 * 1024 * 1024)
      throw new Error("busy: 这段临时对话已较长，请开始新对话");
    this.selection = this.initialSelection();
    if (!this.selection) throw new Error("configuration: 请先在设置中启用可用模型，再配置快速对话默认模型");
    const selection = { ...this.selection };
    const model = this.settings.getModel(selection);
    if (
      !model?.input.includes("image") &&
      (loaded.images.length ||
        this.session?.messages.some(
          (message) =>
            message.role === "user" &&
            Array.isArray(message.content) &&
            message.content.some((part) => part.type === "image"),
        ))
    )
      throw new Error(
        "configuration: 当前模型不支持图片，请选择图片模型或移除附件；历史中的图片也需要图片模型",
      );
    return { loaded, selection, model };
  }
  private async execute(
    run: ActiveRun,
    text: string,
    selection: CombinedSelection,
    loaded: QuickChatImages,
  ): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    let failure: string | undefined;
    let status: "completed" | "aborted" | "error" = "completed";
    try {
      const config = this.settings.snapshot(selection.provider);
      // Only an accepted send creates the default working base; warmup never touches it.
      await mkdir(this.cwd, { recursive: true });
      if (this.closed || run.aborted) return;
      this.runtime.clearProviders();
      this.runtime.registerProvider(
        selection.provider,
        modelRuntimeConfig(config, () =>
          this.settings.getRequestApiKey(selection.provider, this.requestFetch),
        ),
      );
      const model = this.runtime.getModel(selection.provider, selection.modelId);
      if (!model) throw new Error("configuration: 模型不可用");
      if (loaded.images.length && !model.input.includes("image"))
        throw new Error("configuration: 当前模型不支持图片，请选择图片模型");
      const enabled = ["read", "bash", ...(this.webEnabled() ? ["web_search", "web_fetch"] : [])];
      if (enabled.some((name) => !allowedTools.has(name))) throw new Error("configuration: 快速对话工具无效");
      if (!this.session) {
        const created = await createAgentSession({
          cwd: this.cwd,
          // All configuration/resource/transcript owners are explicitly in memory. No HOME discovery.
          agentDir: this.cwd,
          sessionManager: SessionManager.inMemory(this.cwd, { id: this.view.sessionId }),
          settingsManager: SettingsManager.inMemory({ retry: { maxRetries: 2 } }),
          resourceLoader: new StaticResourceLoader(),
          promptTemplate: () => quickChatPromptTemplate,
          modelRuntime: this.runtime,
          model,
          thinkingLevel: toThinking(selection.reasoning, model),
          customTools: this.webTools.tools(),
          tools: enabled,
        });
        if (this.closed || run.aborted) {
          created.session.dispose();
          return;
        }
        this.session = created.session;
      } else {
        await this.session.setModel(model);
        this.session.setThinkingLevel(toThinking(selection.reasoning, model));
        this.session.setActiveToolsByName(enabled);
      }
      if (this.closed || run.aborted) return;
      const session = this.session;
      let ordinal = 0;
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_start" && event.message.role !== "system") ordinal++;
        const projected = projectEvent(event, `${run.id}:${ordinal}`);
        if (projected) this.emit(run, projected);
      });
      // prompt() is deliberate: slash commands, skills, @file expansion and shell hooks are never parsed.
      await session.prompt([text, loaded.context].filter(Boolean).join("\n\n"), { images: loaded.images });
      const last = session.messages.findLast((message) => message.role === "assistant");
      if (last?.role === "assistant" && last.stopReason === "error") {
        status = "error";
        failure = last.errorMessage ?? "模型请求失败";
      } else if (last?.role === "assistant" && last.stopReason === "aborted") status = "aborted";
    } catch (error) {
      status = "error";
      failure = error instanceof Error ? error.message : String(error);
    } finally {
      unsubscribe?.();
      if (run.aborted || this.closed) {
        status = "aborted";
        failure = undefined;
      }
      this.emit(run, {
        type: "settled",
        status,
        endedAt: Date.now(),
        ...(failure ? { error: failure } : {}),
      });
      if (this.active === run) {
        this.active = undefined;
        this.selection = this.initialSelection();
        this.changed(true);
      }
    }
  }
  async waitForIdle(): Promise<void> {
    await this.active?.done;
  }
  retryModelRequest(sessionId: string, runId: string): boolean {
    if (sessionId !== this.view.sessionId || this.active?.id !== runId || this.active.aborted) return false;
    return this.session?.retryModelRequest() ?? false;
  }
  async stop(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.aborted = true;
    await this.session?.abort().catch(() => {});
    await run.done;
  }
  reset(trace?: QuickChatTrace): Promise<void> {
    if (this.closed) return Promise.reject(new Error("busy: 快速对话正在关闭"));
    if (this.resetting) return this.resetting;
    // Reserve before publishing: a synchronous subscriber must not start a run
    // or a second reset while the replacement snapshot is being delivered.
    const pending = Promise.withResolvers<void>();
    this.resetting = pending.promise.finally(() => {
      this.resetting = undefined;
    });
    void this.clearSession(trace).then(pending.resolve, pending.reject);
    return this.resetting;
  }
  private async clearSession(trace?: QuickChatTrace): Promise<void> {
    this.lifetime.abort();
    this.attachments.clear();
    // Native shortcut callbacks can defer an idle Promise continuation until
    // another event wakes the loop. Publish the idle replacement synchronously;
    // an actual run still has to finish cancelling before its session is retired.
    if (this.active) await this.stop();
    trace?.mark("host-stop-ready");
    this.session?.dispose();
    this.session = undefined;
    this.runtime.clearProviders();
    trace?.mark("host-dispose-ready");
    this.view = emptySession(randomUUID(), "快速对话");
    this.lastAcceptedSend = undefined;
    this.selection = this.initialSelection();
    this.lifetime = new AbortController();
    trace?.mark("host-selection-ready");
    this.changed(true);
    trace?.mark("host-published");
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    this.attachments.clear();
    clearTimeout(this.notification);
    this.notification = undefined;
    this.listeners.clear();
    await this.stop();
    await this.resetting;
    this.lifetime.abort();
    this.session?.dispose();
    this.session = undefined;
    this.runtime.clearProviders();
    this.view = emptySession(randomUUID(), "快速对话");
  }
}
