import type { AgentEvent, AgentState, AgentTool, ThinkingLevel } from "ZPI-agent";
import { Agent } from "ZPI-agent";
import type { ImageContent, Model, ModelRetryStatus, SimpleStreamOptions, TranscriptContext } from "ZPI-ai";
import {
  assertSupportedOptions,
  createAssistantMessageEventStream,
  emptyAssistant,
  isContextOverflowMessage,
  isRecoverableLength,
  isRetryableAssistantError,
  retryDelayMs,
} from "ZPI-ai";
import { randomUUID } from "node:crypto";
import type { ParsedInput } from "./commands.ts";
import { parseInput } from "./commands.ts";
import {
  calculateContextTokens,
  compact as compactContext,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "./compaction.ts";
import { withHttpIdleTimeout } from "./http-idle-timeout.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import type { ContextUsage } from "./session-state.ts";
import { contextUsage } from "./session-state.ts";
import { SettingsManager } from "./settings-manager.ts";
import { StreamingToolJournal } from "./streaming-tool-journal.ts";
import type { ResourceDiagnostic, ResourceLoader } from "./types.ts";
export interface InputContext {
  images?: ImageContent[];
  fileReferences?: string[];
}
function withReferences(text: string, references?: string[]): string {
  const instructions = references?.some((path) => path.endsWith("/"))
    ? "Referenced project files and folders (use bash to list folders and read to inspect files when needed)"
    : "Referenced project files (read with the read tool when needed)";
  return references?.length
    ? `${text}\n\n${instructions}:\n${references.map((p) => `- ${JSON.stringify(p)}`).join("\n")}`
    : text;
}
function validateInputContext(input: ParsedInput, context: InputContext): void {
  if ((context.images?.length || context.fileReferences?.length) && input.kind === "compact")
    throw new Error("invalid_input: 此控制命令不接收图片或文件引用");
}
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentState["messages"]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string }
  | { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel }
  | { type: "model_retry"; status: ModelRetryStatus | null }
  | {
      type: "compaction";
      id: string;
      status: "running" | "completed" | "aborted" | "error" | "noop";
      origin: "manual" | "auto";
      error?: string;
    }
  | { type: "command_result"; message: string };
export class AgentSession {
  private agent: Agent;
  private manager: SessionManager;
  private allTools: Map<string, AgentTool>;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private running?: Promise<void>;
  private active = false;
  private disposed = false;
  private abortRequested = false;
  private fault?: Error;
  private runtime: ModelRuntime;
  private resources?: {
    loader: ResourceLoader;
    buildPrompt: () => string;
    settingsManager?: SettingsManager;
  };
  private compactController?: AbortController;
  readonly settingsManager: SettingsManager;
  private overflowRecoveryAttempted = false;
  private retryAttempt = 0;
  private recoveredCalls = new WeakSet<object>();
  constructor(
    model: Model,
    runtime: ModelRuntime,
    manager: SessionManager,
    allTools: AgentTool[],
    activeTools: AgentTool[],
    systemPrompt: string,
    thinkingLevel: ThinkingLevel,
    resources?: {
      loader: ResourceLoader;
      buildPrompt: () => string;
      settingsManager?: SettingsManager;
    },
  ) {
    this.manager = manager;
    this.runtime = runtime;
    this.resources = resources;
    this.settingsManager = resources?.settingsManager ?? SettingsManager.inMemory();
    this.allTools = new Map(allTools.map((t) => [t.name, t]));
    const restored = manager.buildSessionContext();
    if (!restored.messages.some((m) => m.role === "system"))
      manager.appendMessage({
        role: "system",
        content: "",
        sections: { "ZPI.instructions": systemPrompt },
        toolsAdded: activeTools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
        timestamp: Date.now(),
      });
    const sections = restored.messages
      .filter((m) => m.role === "system")
      .map((m) => m.sections?.["ZPI.instructions"])
      .filter((value) => value !== undefined);
    const prior = sections.at(-1);
    if (prior !== undefined && prior !== systemPrompt)
      manager.appendMessage({
        role: "system",
        content: "",
        sections: { "ZPI.instructions": systemPrompt },
        timestamp: Date.now(),
      });
    this.agent = new Agent({
      initialState: {
        model,
        thinkingLevel,
        messages: manager.buildSessionContext().messages,
        tools: activeTools,
      },
      streamFn: (m, c, o) => this.streamWithRecovery(m, c, o),
      prepareNextTurnWithContext: async (turn, signal) => {
        const settings = this.settingsManager.getCompactionSettings(this.model);
        if (
          this.model.contextWindow > 0 &&
          shouldCompact(this.estimateTokens(turn.context.messages), this.model.contextWindow, settings)
        ) {
          if (await this.tryAutoCompact(signal))
            return { context: { ...turn.context, messages: this.manager.buildSessionContext().messages } };
        }
        return undefined;
      },
      toolExecution: "parallel",
    });
    const streamingTools = new StreamingToolJournal(manager, () => this.notifyLastEntry());
    this.agent.subscribe((event) => {
      try {
        streamingTools.observe(event);
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          !this.recoveredCalls.has(event.message)
        ) {
          if (!["error", "length"].includes(event.message.stopReason)) this.overflowRecoveryAttempted = false;
          if (event.message.stopReason !== "error" && this.retryAttempt > 0) {
            this.notify({ type: "model_retry", status: null });
            this.retryAttempt = 0;
          }
        }
        if (event.type === "message_end") {
          this.manager.appendMessage(event.message);
          this.notifyLastEntry();
        }
      } catch (e) {
        this.fault = e instanceof Error ? e : new Error(String(e));
        this.agent.abort();
        throw this.fault;
      }
      const last = event.type === "agent_end" ? event.messages.at(-1) : undefined;
      this.notify(
        event.type === "agent_end"
          ? {
              ...event,
              willRetry: last?.role === "assistant" && this.canRetry(last),
            }
          : event,
      );
    });
  }
  get state(): AgentState {
    return this.agent.state;
  }
  get messages(): AgentState["messages"] {
    return this.state.messages;
  }
  get model(): Model {
    return this.state.model;
  }
  get thinkingLevel(): ThinkingLevel {
    return this.state.thinkingLevel;
  }
  get isStreaming(): boolean {
    return this.active;
  }
  get isIdle(): boolean {
    return !this.active;
  }
  get systemPrompt(): string {
    return this.state.systemPrompt;
  }
  getContextUsage(): ContextUsage {
    return contextUsage(this.manager.getEntries(), this.model);
  }
  listSkills(): SkillList {
    return this.resources?.loader.listSkills?.() ?? { skills: [], diagnostics: [] };
  }
  getResourceDiagnostics(): ResourceDiagnostic[] {
    return [
      ...(this.resources?.loader.getDiagnostics?.() ?? []),
      ...this.settingsManager.getErrors().map(({ path, error }) => ({ path, message: error.message })),
    ];
  }
  async loadSkill(name: string): Promise<LoadedSkill> {
    if (!this.resources?.loader.loadSkill) throw new Error(`Skill not found: ${name}`);
    return this.resources.loader.loadSkill(name);
  }
  async prepareInput(text: string, context: InputContext = {}): Promise<ParsedInput> {
    this.idleCheck();
    await this.resources?.loader.reload?.();
    const parsed = parseInput(
      text,
      this.listSkills().skills.map((skill) => skill.name),
    );
    validateInputContext(parsed, context);
    if (parsed.kind === "skill") {
      const skill = await this.loadSkill(parsed.name);
      return {
        kind: "prompt",
        text: `Use Skill ${skill.name} from ${skill.path}. Resolve relative paths against ${skill.baseDir}.\n\n${skill.body}\n\nUser task:\n${parsed.task || "Follow this skill's instructions."}`,
      };
    }
    if (parsed.kind === "init")
      return {
        kind: "prompt",
        text: `Inspect this project (${this.manager.getCwd()}) and create or edit ONLY its root AGENTS.md. If it exists, read it first and use precise edits to preserve existing rules; do not overwrite it wholesale. Derive concise instructions from the actual project. Never modify the user-level AGENTS.md. Additional requirements: ${parsed.args || "none"}`,
      };
    if (parsed.kind === "compact" && !this.alreadyCompacted()) this.compactionBoundary();
    return parsed;
  }
  async submit(text: string): Promise<void> {
    return this.executeInput(await this.prepareInput(text));
  }
  async executeInput(input: ParsedInput, context: InputContext = {}): Promise<void> {
    validateInputContext(input, context);
    if (input.kind === "compact") return this.compact(input.args);
    if (input.kind !== "prompt") throw new Error("Input must be prepared before execution");
    return this.prompt(withReferences(input.text, context.fileReferences), { images: context.images });
  }
  private syncSection(name: string, value: string | null): void {
    const prior = this.agent.state.messages
      .filter((m) => m.role === "system" && m.sections && name in m.sections)
      .at(-1);
    if (prior?.role === "system" && prior.sections?.[name] === value) return;
    if (!prior && value === null) return;
    this.manager.appendMessage({
      role: "system",
      content: "",
      sections: { [name]: value },
      timestamp: Date.now(),
    });
    this.notifyLastEntry();
    this.agent.state.messages = this.manager.buildSessionContext().messages;
  }
  private async refreshInstructions(): Promise<void> {
    await this.resources?.loader.reload?.();

    if (this.resources) this.syncSection("ZPI.instructions", this.resources.buildPrompt());
  }
  private compactionBoundary() {
    const preparation = prepareCompaction(
      this.manager.getEntries(),
      this.settingsManager.getCompactionSettings(this.model),
    );
    if (!preparation) throw new Error("invalid_input: 没有可压缩的完整对话内容");
    return preparation;
  }
  private estimateTokens(messages: AgentState["messages"]): number {
    const estimate = estimateContextTokens(messages);
    const boundary = this.manager.getEntries().findLast((entry) => entry.type === "compaction");
    const source = estimate.lastUsageIndex === null ? undefined : messages[estimate.lastUsageIndex];
    if (boundary && source?.role === "assistant" && source.timestamp <= Date.parse(boundary.timestamp))
      return 0;
    return estimate.tokens;
  }
  private async tryAutoCompact(signal?: AbortSignal): Promise<boolean> {
    if (!prepareCompaction(this.manager.getEntries(), this.settingsManager.getCompactionSettings(this.model)))
      return false;
    try {
      await this.summarize(false, "", signal);
      return true;
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }
  private async checkCompaction(signal?: AbortSignal, includeAborted = false): Promise<boolean> {
    const message = this.messages.findLast((message) => message.role === "assistant");
    const settings = this.settingsManager.getCompactionSettings(this.model);
    if (
      !settings.enabled ||
      !message ||
      message.role !== "assistant" ||
      (!includeAborted && message.stopReason === "aborted")
    )
      return false;
    const boundary = this.manager.getEntries().findLast((entry) => entry.type === "compaction");
    if (boundary && message.timestamp <= Date.parse(boundary.timestamp)) return false;
    const sameModel = message.provider === this.model.provider && message.model === this.model.id;
    const overflow =
      sameModel &&
      (isContextOverflowMessage(message, this.model.contextWindow) ||
        isRecoverableLength(message, this.model.maxTokens));
    if (overflow) {
      const retry = message.stopReason !== "stop";
      if (retry && this.overflowRecoveryAttempted) return false;
      if (retry) {
        this.overflowRecoveryAttempted = true;
        this.dropFailedAssistant();
      }
      if (!(await this.tryAutoCompact(signal))) return false;
      this.state.messages = this.manager.buildSessionContext().messages;
      if (retry) this.dropFailedAssistant();
      return retry;
    }
    const direct = message.stopReason === "error" ? 0 : calculateContextTokens(message.usage);
    const tokens = direct || this.estimateTokens(this.messages);
    if (shouldCompact(tokens, this.model.contextWindow, settings) && (await this.tryAutoCompact(signal)))
      this.state.messages = this.manager.buildSessionContext().messages;
    return false;
  }
  private dropFailedAssistant(): void {
    const last = this.messages.at(-1);
    if (last?.role === "assistant" && ["error", "length"].includes(last.stopReason))
      this.state.messages = this.messages.slice(0, -1);
  }
  private async waitForRetry(
    message: Extract<AgentState["messages"][number], { role: "assistant" }>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.canRetry(message)) return false;
    const settings = this.settingsManager.getRetrySettings();
    this.dropFailedAssistant();
    this.retryAttempt++;
    const delay = retryDelayMs(settings, this.retryAttempt);
    this.notify({
      type: "model_retry",
      status: {
        attempt: this.retryAttempt,
        maxRetries: settings.maxRetries,
        retryDelayMs: delay,
        errorStatus: message.errorDetails?.status ?? null,
      },
    });
    await new Promise<void>((resolve, reject) => {
      const abort = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(new DOMException("Request aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve();
      }, delay);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
    return true;
  }
  private canRetry(message: Extract<AgentState["messages"][number], { role: "assistant" }>): boolean {
    const settings = this.settingsManager.getRetrySettings();
    return (
      !this.abortRequested &&
      !(
        !settings.enabled ||
        this.retryAttempt >= settings.maxRetries ||
        isContextOverflowMessage(message, this.model.contextWindow) ||
        !isRetryableAssistantError(message)
      )
    );
  }
  private requestOptions(options: SimpleStreamOptions): SimpleStreamOptions {
    const provider = this.settingsManager.getProviderRetrySettings();
    const idle = this.settingsManager.getHttpIdleTimeoutMs();
    const requestFetch = options.fetch ?? this.runtime.fetch;
    return {
      ...provider,
      ...options,
      timeoutMs: options.timeoutMs ?? provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
      maxRetries: options.maxRetries ?? provider.maxRetries,
      maxRetryDelayMs: options.maxRetryDelayMs ?? provider.maxRetryDelayMs,
      fetch: withHttpIdleTimeout(requestFetch, idle),
    };
  }
  private alreadyCompacted(): boolean {
    const entries = this.manager.getEntries();
    const last = entries.findLastIndex((entry) => entry.type === "compaction");
    return last >= 0 && !entries.slice(last + 1).some((entry) => entry.type === "message");
  }
  private async summarize(manual: boolean, instructions: string, signal?: AbortSignal): Promise<void> {
    const id = randomUUID();
    const origin = manual ? "manual" : "auto";
    this.notify({ type: "compaction", id, status: "running", origin });
    try {
      await this.summarizeContext(manual, instructions, signal);
      this.notify({ type: "compaction", id, status: "completed", origin });
    } catch (error) {
      this.notify({
        type: "compaction",
        id,
        status: signal?.aborted ? "aborted" : "error",
        origin,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
  private async summarizeContext(manual: boolean, instructions: string, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const preparation = this.compactionBoundary();
    const result = await compactContext(
      preparation,
      this.model,
      undefined,
      undefined,
      instructions || undefined,
      signal,
      this.thinkingLevel,
      (model, context, options) =>
        this.runtime.streamSimple(model, context, this.requestOptions(options ?? {})),
      this.settingsManager.getRetrySettings(),
      {
        onRetryScheduled: (attempt, maxRetries, retryDelayMs) =>
          this.notify({
            type: "model_retry",
            status: { attempt, maxRetries, retryDelayMs, errorStatus: null },
          }),
        onRetryFinished: () => this.notify({ type: "model_retry", status: null }),
      },
      randomUUID(),
    );
    signal?.throwIfAborted();
    this.manager.appendCompaction(
      result.summary,
      result.firstKeptEntryId,
      result.tokensBefore,
      result.details as { readFiles: string[]; modifiedFiles: string[] },
      result.usage,
    );
    this.notifyLastEntry();
    this.notify({
      type: "command_result",
      message: manual
        ? "上下文已压缩；完整历史保留，下一次请求使用摘要和最近回合。"
        : "上下文接近容量，已自动压缩。",
    });
  }
  private streamWithRecovery(model: Model, context: TranscriptContext, options: SimpleStreamOptions = {}) {
    const output = createAssistantMessageEventStream();
    let partial = emptyAssistant(model);
    void (async () => {
      const response = this.runtime.streamSimple(
        model,
        context,
        this.requestOptions({ ...options, sessionId: this.sessionId }),
      );
      let started = false;
      for await (const event of response) {
        partial =
          event.type === "error" ? event.error : event.type === "done" ? event.message : event.partial;
        if (event.type === "start") {
          started = true;
          output.push(event);
          continue;
        }
        if (
          event.type === "error" &&
          event.error.content.some((block) => block.type === "toolCall") &&
          (await this.waitForRetry(event.error, options.signal))
        ) {
          // Preserve the existing streamed-read recovery: drain completed calls once,
          // discard partial prose and continue with their paired results.
          const recovered = emptyAssistant(model);
          recovered.content = event.error.content.filter((block) => block.type === "toolCall");
          recovered.stopReason = "toolUse";
          this.recoveredCalls.add(recovered);
          if (!started) output.push({ type: "start", partial: recovered });
          output.push({ type: "reset", partial: recovered });
          output.end(recovered);
          return;
        }
        output.push(event);
      }
    })().catch((error: unknown) => {
      const result = partial;
      result.stopReason = options.signal?.aborted ? "aborted" : "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      output.end(result);
    });
    return output;
  }
  compact(instructions = ""): Promise<void> {
    try {
      this.idleCheck();
      if (this.alreadyCompacted()) {
        this.notify({ type: "compaction", id: randomUUID(), status: "noop", origin: "manual" });
        this.notify({ type: "command_result", message: "上下文已是最新，无需压缩" });
        return Promise.resolve();
      }
      this.compactionBoundary();
    } catch (error) {
      return Promise.reject(error);
    }
    this.active = true;
    this.abortRequested = false;
    const controller = new AbortController();
    this.compactController = controller;
    this.running = (async () => {
      await this.resources?.loader.reload?.();
      await this.summarize(true, instructions, controller.signal);
      this.state.messages = this.manager.buildSessionContext().messages;
    })().finally(() => {
      this.compactController = undefined;
      this.active = false;
      this.notify({ type: "agent_settled" });
    });
    return this.running;
  }
  get sessionId(): string {
    return this.manager.getSessionId();
  }
  get sessionFile(): string | undefined {
    return this.manager.getSessionFile();
  }
  get sessionName(): string | undefined {
    return this.manager
      .getEntries()
      .filter((e) => e.type === "session_info")
      .at(-1)?.name;
  }
  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  private notify(event: AgentSessionEvent): void {
    for (const l of this.listeners) {
      try {
        const result: unknown = l(event);
        if (result instanceof Promise) void result.catch(() => {});
      } catch {
        /* Notification listeners cannot control persistence or settlement. */
      }
    }
  }
  private notifyLastEntry(): void {
    const entry = this.manager.getLastEntry();
    if (entry) this.notify({ type: "entry_appended", entry });
  }
  private idleCheck(): void {
    if (this.disposed) throw new Error("Session disposed");
    if (this.fault) throw this.fault;
    if (this.active) throw new Error("Session busy");
  }
  prompt(text: string, options: { images?: ImageContent[] } = {}): Promise<void> {
    try {
      this.idleCheck();
      assertSupportedOptions(options, ["images"], "Session.prompt");
      this.validateImages(options.images);
    } catch (e) {
      return Promise.reject(e);
    }
    this.active = true;
    this.abortRequested = false;
    this.overflowRecoveryAttempted = false;
    this.retryAttempt = 0;
    this.compactController = new AbortController();
    this.running = Promise.resolve()
      .then(async () => {
        await this.refreshInstructions();
        if (this.abortRequested) return;
        const signal = this.compactController?.signal;
        await this.checkCompaction(signal, true);
        if (signal?.aborted) return;
        await this.agent.prompt(text, options.images);
        while (!signal?.aborted) {
          const last = this.messages.findLast((message) => message.role === "assistant");
          if (last?.role === "assistant" && (await this.waitForRetry(last, signal))) {
            await this.agent.continue();
            continue;
          }
          if (!(await this.checkCompaction(signal))) break;
          await this.agent.continue();
        }
      })
      .catch((error) => {
        if (!this.abortRequested) throw error;
      })
      .finally(() => {
        this.compactController = undefined;
        this.notify({ type: "model_retry", status: null });
        this.active = false;
        this.notify({ type: "agent_settled" });
      });
    return this.running;
  }
  async abort(): Promise<void> {
    this.abortRequested = true;
    this.compactController?.abort();
    this.agent.abort();
    await this.running;
  }
  async waitForIdle(): Promise<void> {
    await this.running;
  }
  dispose(): void {
    this.disposed = true;
    this.compactController?.abort();
    this.agent.abort();
    this.listeners.clear();
  }
  getToolDefinitions(): AgentTool[] {
    return [...this.allTools.values()];
  }
  validateImages(images?: ImageContent[]): void {
    if (this.model.input.includes("image")) return;
    if (
      images?.length ||
      this.messages.some(
        (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image"),
      )
    )
      throw new Error(
        "configuration: 当前模型不支持图片；请选择图片模型或移除新附件（有效历史中的图片也需图片模型）",
      );
  }
  getActiveToolNames(): string[] {
    return this.state.tools.map((t) => t.name);
  }
  setActiveToolsByName(names: string[]): void {
    this.idleCheck();
    this.state.tools = names.map((n) => {
      const t = this.allTools.get(n);
      if (!t) throw new Error(`Unknown tool ${n}`);
      return t;
    });
  }
  async setModel(model: Model): Promise<void> {
    this.idleCheck();
    if (model.provider !== this.model.provider || model.id !== this.model.id) {
      this.manager.appendModelChange(model.provider, model.id);
      this.notifyLastEntry();
    }
    this.state.model = model;
  }
  setThinkingLevel(thinkingLevel: ThinkingLevel): void {
    this.idleCheck();
    this.manager.appendThinkingLevelChange(thinkingLevel);
    this.state.thinkingLevel = thinkingLevel;
    this.notifyLastEntry();
    this.notify({ type: "thinking_level_changed", thinkingLevel });
  }
  setSessionName(name: string): void {
    this.idleCheck();
    this.manager.appendSessionInfo(name);
    this.notifyLastEntry();
    this.notify({ type: "session_info_changed", name });
  }
}
