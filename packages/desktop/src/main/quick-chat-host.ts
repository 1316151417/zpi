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
import { projectEvent } from "./projection.ts";
import { quickChatPromptTemplate } from "./quick-chat-prompt.ts";
import { recordedQuickChatWebSourceIcon } from "./quick-chat-source-icons.ts";
import { resolveModel, type SettingsStore } from "./storage.ts";
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
  private runtime = new ModelRuntime();
  private view: SessionView = emptySession(randomUUID(), "快速对话");
  private selection: CombinedSelection | null;
  private active?: ActiveRun;
  private resetting?: Promise<void>;
  private closed = false;
  private revision = 0;
  private listeners = new Set<(snapshot: QuickChatSnapshot) => void>();
  private notification?: ReturnType<typeof setTimeout>;
  private webTools: WebTools;
  private now: () => number;
  private lastAcceptedSend?: number;
  private lifetime = new AbortController();

  constructor(
    settings: SettingsStore,
    cwd: string,
    requestFetch: typeof fetch = fetch,
    now: () => number = () => performance.now(),
  ) {
    this.now = now;
    this.settings = settings;
    this.cwd = resolve(cwd);
    this.requestFetch = requestFetch;
    this.runtime = new ModelRuntime(requestFetch);
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
  async resetIfExpired(): Promise<void> {
    if (this.resetting) return this.resetting;
    const elapsed = this.lastAcceptedSend === undefined ? 0 : this.now() - this.lastAcceptedSend;
    // A monotonic clock avoids wall-clock adjustments; injected invalid/backward clocks fail closed.
    if (!Number.isFinite(elapsed) || elapsed < QUICK_CHAT_IDLE_MS) return;
    await this.reset();
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
    if (this.active || this.resetting) throw new Error("busy: 请先停止当前回复");
  }
  send(text: string): void {
    this.idle();
    if (typeof text !== "string" || !text.trim() || text.length > 32_000)
      throw new Error("invalid_input: 消息需为 1–32000 个字符");
    if (this.view.runs.length >= 100 || sessionViewBytes(this.view) > 8 * 1024 * 1024)
      throw new Error("busy: 这段临时对话已较长，请开始新对话");
    this.selection = this.initialSelection();
    if (!this.selection) throw new Error("configuration: 请先在设置中启用可用模型，再配置快速对话默认模型");
    const selection = { ...this.selection };
    // Reserve synchronously, before initialization or network work can yield to another IPC call.
    const run: ActiveRun = { id: randomUUID(), aborted: false, done: Promise.resolve() };
    this.active = run;
    const now = this.now();
    this.lastAcceptedSend = Number.isFinite(now) ? now : undefined;
    const model = this.settings.getModel(selection);
    this.emit(run, {
      type: "started",
      text: text.trim(),
      startedAt: Date.now(),
      modelLabel: model?.name ?? selection.modelId,
    });
    run.done = this.execute(run, text.trim(), selection);
  }
  private async execute(run: ActiveRun, text: string, selection: CombinedSelection): Promise<void> {
    let unsubscribe: (() => void) | undefined;
    let failure: string | undefined;
    let status: "completed" | "aborted" | "error" = "completed";
    try {
      const config = this.settings.snapshot(selection.provider);
      // Only an accepted send creates the default working base; warmup never touches it.
      await mkdir(this.cwd, { recursive: true });
      if (this.closed || run.aborted) return;
      this.runtime.clearProviders();
      this.runtime.registerProvider(selection.provider, {
        baseUrl: config.baseUrl,
        apiKey: config.apiKey,
        ...(config.preset === "openai-chatgpt"
          ? { getApiKey: () => this.settings.getRequestApiKey(selection.provider, this.requestFetch) }
          : {}),
        models: config.models
          .filter((m) => m.enabled !== false)
          .map((m) => {
            const { provider: _provider, baseUrl: _url, ...model } = resolveModel(config, m);
            return model;
          }),
      });
      const model = this.runtime.getModel(selection.provider, selection.modelId);
      if (!model) throw new Error("configuration: 模型不可用");
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
      await session.prompt(text);
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
  async stop(): Promise<void> {
    const run = this.active;
    if (!run) return;
    run.aborted = true;
    await this.session?.abort().catch(() => {});
    await run.done;
  }
  reset(): Promise<void> {
    if (this.closed) return Promise.reject(new Error("busy: 快速对话正在关闭"));
    if (this.resetting) return this.resetting;
    this.lifetime.abort();
    this.resetting = this.clearSession().finally(() => {
      this.resetting = undefined;
    });
    return this.resetting;
  }
  private async clearSession(): Promise<void> {
    await this.stop();
    this.session?.dispose();
    this.session = undefined;
    this.runtime.clearProviders();
    this.view = emptySession(randomUUID(), "快速对话");
    this.lastAcceptedSend = undefined;
    this.selection = this.initialSelection();
    this.lifetime = new AbortController();
    this.changed(true);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
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
