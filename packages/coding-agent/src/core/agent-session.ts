import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentState, AgentTool, ThinkingLevel } from "@zpi-dev/agent";
import { Agent } from "@zpi-dev/agent";
import type {
  ImageContent,
  Message,
  Model,
  ModelRetryStatus,
  ModelWaitStatus,
  SimpleStreamOptions,
  TranscriptContext,
  UserGuide,
} from "@zpi-dev/ai";
import {
  assertSupportedOptions,
  clampThinkingLevel,
  createAssistantMessageEventStream,
  emptyAssistant,
  isContextOverflowMessage,
  isRecoverableLength,
  isRetryableAssistantError,
  ModelRequestRetryError,
  retryAttemptLimit,
  retryDelayMs,
} from "@zpi-dev/ai";
import { ResponsesSession } from "@zpi-dev/ai/api/responses-session";
import { expandPluginCommand } from "../plugins/assembly.ts";
import type { HookExecution, HookRegistration } from "../plugins/hooks.ts";
import { SessionHooks } from "../plugins/session-hooks.ts";
import type { PluginCommand } from "../plugins/types.ts";
import type { ParsedInput } from "./commands.ts";
import { listCommands, parseInput } from "./commands.ts";
import {
  calculateContextTokens,
  compact as compactContext,
  estimateContextTokens,
  prepareCompaction,
  shouldCompact,
} from "./compaction.ts";
import { contextUpdate } from "./dynamic-context.ts";
import { withHttpIdleTimeout } from "./http-idle-timeout.ts";
import { buildDefaultMicrocompactThreshold, maybeMicrocompact } from "./microcompact.ts";
import {
  type ModelPerformance,
  type ModelPerformanceTotals,
  modelPerformance,
  performanceScope,
  SessionPerformance,
} from "./model-performance.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import type { ContextUsage } from "./session-state.ts";
import { contextUsage } from "./session-state.ts";
import { SettingsManager } from "./settings-manager.ts";
import { StreamingToolJournal } from "./streaming-tool-journal.ts";
import type { SystemContext } from "./system-prompt.ts";
import type { ResourceDiagnostic, ResourceLoader } from "./types.ts";
export interface InputContext {
  /** Client identity for this input; persisted on the user message entry and echoed by message events. */
  inputId?: string;
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
  if (
    context.inputId !== undefined &&
    (typeof context.inputId !== "string" || !context.inputId || context.inputId.length > 256)
  )
    throw new Error("invalid_input: inputId 必须是非空且不超过 256 字符的字符串");
}
export type AgentSessionEvent =
  | { type: "hook_execution"; execution: HookExecution }
  | { type: "model_performance"; performance: ModelPerformance; totals: ModelPerformanceTotals }
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentState["messages"]; willRetry: boolean }
  | { type: "agent_settled" }
  | { type: "entry_appended"; entry: SessionEntry }
  | { type: "session_info_changed"; name: string }
  | { type: "thinking_level_changed"; thinkingLevel: ThinkingLevel }
  | { type: "model_retry"; status: ModelRetryStatus | null }
  | { type: "model_wait"; status: ModelWaitStatus | null }
  | {
      type: "compaction";
      id: string;
      status: "running" | "completed" | "aborted" | "error" | "noop";
      origin: "manual" | "auto";
      error?: string;
    }
  | { type: "command_result"; message: string };
export class AgentSession {
  private modelRequestOptions?: () => SimpleStreamOptions;
  private onCompaction?: (
    phase: "before" | "after",
    context: { manual: boolean; instructions: string },
    signal?: AbortSignal,
  ) => Promise<void>;
  private agent: Agent;
  private pluginCommands: readonly PluginCommand[];
  private hooks: SessionHooks;
  private manager: SessionManager;
  private steering: import("@zpi-dev/ai").UserMessage[] = [];
  private pendingMessages: import("@zpi-dev/ai").UserMessage[] = [];
  private allTools: Map<string, AgentTool>;
  private listeners = new Set<(event: AgentSessionEvent) => void>();
  private running?: Promise<void>;
  private active?: "prompt" | "compact";
  private disposed = false;
  private abortRequested = false;
  private fault?: Error;
  private runtime: ModelRuntime;
  private responsesSession?: ResponsesSession;
  private responsesWarmupTimer?: ReturnType<typeof setTimeout>;
  private responsesWarmupController?: AbortController;
  private resources?: {
    loader: ResourceLoader;
    buildContext?: () => SystemContext;
    settingsManager?: SettingsManager;
  };
  private compactController?: AbortController;
  readonly settingsManager: SettingsManager;
  private overflowRecoveryAttempted = false;
  private retryAttempt = 0;
  private recoveryStartedAt?: number;
  private retryCurrentRequest?: () => boolean;
  private lastAssistantCompletedAtMs?: number;
  private microcompactProjection = new WeakMap<Message, Message>();
  private recoveredCalls = new WeakSet<object>();
  private performance: SessionPerformance;
  get modelPerformance(): ModelPerformance {
    return modelPerformance(this.performance.snapshot, performanceScope(this.model, this.thinkingLevel));
  }
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
      buildContext?: () => SystemContext;
      settingsManager?: SettingsManager;
    },
    performanceTotals?: ModelPerformanceTotals,
    extensions: {
      modelRequestOptions?: () => SimpleStreamOptions;
      onCompaction?: (
        phase: "before" | "after",
        context: { manual: boolean; instructions: string },
        signal?: AbortSignal,
      ) => Promise<void>;
      beforeModelRequest?: (model: Model, context: import("@zpi-dev/ai").Context) => void;
      commands?: readonly PluginCommand[];
      hooks?: readonly (HookRegistration & { pluginId?: string })[];
    } = {},
  ) {
    this.modelRequestOptions = extensions.modelRequestOptions;
    this.onCompaction = extensions.onCompaction;
    this.pluginCommands = structuredClone(extensions.commands ?? []);
    this.hooks = new SessionHooks(
      {
        sessionId: manager.getSessionId(),
        cwd: manager.getCwd(),
        source: manager.buildSessionContext().messages.some((m) => m.role === "user") ? "resume" : "startup",
      },
      extensions.hooks ?? [],
      (execution) => this.notify({ type: "hook_execution", execution }),
    );
    this.performance = new SessionPerformance(
      (performance, totals) => this.notify({ type: "model_performance", performance, totals }),
      performanceTotals,
    );
    this.manager = manager;
    this.runtime = runtime;
    this.resources = resources;
    this.settingsManager = resources?.settingsManager ?? SettingsManager.inMemory();
    this.allTools = new Map(allTools.map((t) => [t.name, t]));
    for (const message of initialSystemMessages(
      manager,
      activeTools,
      systemPrompt,
      resources?.buildContext?.(),
    ))
      manager.appendMessage(message);
    this.lastAssistantCompletedAtMs = manager
      .buildSessionContext()
      .messages.findLast(
        (message) =>
          message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted",
      )?.timestamp;
    this.agent = new Agent({
      initialState: {
        model,
        thinkingLevel,
        messages: manager.buildSessionContext().messages,
        tools: activeTools,
      },
      streamFn: (m, c, o) => {
        extensions.beforeModelRequest?.(m, c);
        return this.streamWithRecovery(m, c, o);
      },
      transformContext: async (messages) => {
        const config = this.settingsManager.getMicrocompactSettings();
        const settings = this.settingsManager.getCompactionSettings(this.model);
        const projected = messages.map((message) => this.microcompactProjection.get(message) ?? message);
        const result = maybeMicrocompact({
          messages: projected,
          config: {
            ...config,
            thresholdTokens:
              config.thresholdTokens ??
              buildDefaultMicrocompactThreshold(this.model.contextWindow - settings.reserveTokens),
          },
          lastAssistantCompletedAtMs: this.lastAssistantCompletedAtMs,
        });
        if (result.boundary) {
          for (const [index, message] of messages.entries())
            if (result.messages[index] !== message)
              this.microcompactProjection.set(message, result.messages[index]);
          await this.manager.appendEntryAsync({ type: "microcompact", data: result.boundary });
          this.notifyLastEntry();
        }
        return result.messages;
      },
      prepareNextTurnWithContext: async (turn, signal) => {
        const updated = await this.syncContext();
        const settings = this.settingsManager.getCompactionSettings(this.model);
        if (
          this.model.contextWindow > 0 &&
          shouldCompact(this.estimateTokens(turn.context.messages), this.model.contextWindow, settings)
        ) {
          if (await this.tryAutoCompact(signal))
            return { context: { ...turn.context, messages: this.manager.buildSessionContext().messages } };
        }
        return updated
          ? { context: { ...turn.context, messages: this.manager.buildSessionContext().messages } }
          : undefined;
      },
      beforeToolCall: this.hooks.runner.hasToolHooks ? this.hooks.beforeToolCall : undefined,
      afterToolCall: this.hooks.runner.hasToolHooks ? this.hooks.afterToolCall : undefined,
      beforeStop: this.hooks.beforeStop,
      streamingToolExecution: this.hooks.runner.hasToolHooks ? "off" : "readOnly",
      toolExecution: "parallel",
      getSteeringMessages: () => this.steering.splice(0),
      getPendingMessages: () => [...this.hooks.drainMessages(), ...this.pendingMessages.splice(0)],
    });
    const streamingTools = new StreamingToolJournal(manager, () => this.notifyLastEntry());
    this.agent.subscribe(async (event) => {
      try {
        if (event.type === "tool_execution_start") this.performance.toolStart(event.toolCallId);
        if (event.type === "tool_execution_end") this.performance.toolEnd(event.toolCallId);
        await streamingTools.observe(event);
        if (
          event.type === "message_end" &&
          event.message.role === "assistant" &&
          !this.recoveredCalls.has(event.message)
        ) {
          if (!["error", "length"].includes(event.message.stopReason)) this.overflowRecoveryAttempted = false;
          if (event.message.stopReason !== "error") {
            this.notify({ type: "model_retry", status: null });
            this.retryAttempt = 0;
            this.recoveryStartedAt = undefined;
          }
        }
        if (event.type === "message_end") {
          if (event.message.role === "assistant" && !["error", "aborted"].includes(event.message.stopReason))
            this.lastAssistantCompletedAtMs = Date.now();
          await this.manager.appendEntryAsync({ type: "message", message: event.message });
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
    this.prepareResponsesSession();
  }
  private prepareResponsesSession(): void {
    clearTimeout(this.responsesWarmupTimer);
    this.responsesWarmupTimer = undefined;
    this.responsesWarmupController?.abort();
    this.responsesWarmupController = undefined;
    this.responsesSession?.dispose();
    this.responsesSession = undefined;
    if (!this.runtime.canUseResponsesSession(this.model)) return;
    const connection = new ResponsesSession({
      resolveProxy: this.runtime.responsesProxy,
      onDiagnostic: this.runtime.responsesDiagnosticObserver(this.model, this.sessionId),
    });
    this.responsesSession = connection;
    // Let callers finish selecting model + reasoning before capturing warmup parameters.
    this.responsesWarmupTimer = setTimeout(() => {
      this.responsesWarmupTimer = undefined;
      if (this.disposed || connection !== this.responsesSession) return;
      const controller = new AbortController();
      this.responsesWarmupController = controller;
      // Best effort, concurrent with resource loading/user input; never journaled or measured.
      void Promise.resolve()
        .then(() => {
          if (controller.signal.aborted || connection !== this.responsesSession) return;
          return this.runtime
            .streamSimple(
              this.model,
              { messages: this.messages },
              {
                sessionId: this.sessionId,
                responsesSession: connection,
                responsesWarmup: true,
                reasoning: this.thinkingLevel,
                signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
                streamFirstResponseTimeoutMs: 15_000,
                maxRetries: 0,
              },
            )
            .result();
        })
        .catch(() => {})
        .finally(() => {
          if (this.responsesWarmupController === controller) this.responsesWarmupController = undefined;
        });
    }, 0);
    this.responsesWarmupTimer.unref();
  }
  static async create(...args: ConstructorParameters<typeof AgentSession>): Promise<AgentSession> {
    const [, , manager, , activeTools, systemPrompt, , resources] = args;
    for (const message of initialSystemMessages(
      manager,
      activeTools,
      systemPrompt,
      resources?.buildContext?.(),
    ))
      await manager.appendEntryAsync({ type: "message", message });
    return new AgentSession(...args);
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
    return this.active !== undefined;
  }
  get isIdle(): boolean {
    return !this.active;
  }
  get systemPrompt(): string {
    return this.state.systemPrompt;
  }
  getContextUsage(): ContextUsage {
    const entries = this.manager.getContextEntries();
    const estimate = estimateContextTokens(this.messages);
    const settings = this.settingsManager.getCompactionSettings(this.model);
    return {
      ...contextUsage(entries, this.model),
      estimatedTokens: this.estimateTokens(this.messages, estimate),
      estimateSource: estimate.lastUsageIndex === null ? "local" : "server usage + local",
      compaction: {
        enabled: settings.enabled,
        reserveTokens: settings.reserveTokens,
        threshold: this.model.contextWindow - settings.reserveTokens,
        compacted: entries.some((entry) => entry.type === "compaction"),
      },
    };
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
    const parsed = parseInput(text);
    validateInputContext(parsed, context);
    if (parsed.kind === "prompt") {
      const invocation = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(text);
      const command = invocation && this.pluginCommands.find((command) => command.name === invocation[1]);
      if (command)
        return {
          kind: "prompt",
          text: expandPluginCommand(command, invocation?.[2]?.trim() ?? "", this.manager.getCwd()),
        };
    }
    if (parsed.kind === "compact" && !this.alreadyCompacted()) this.compactionBoundary();
    return parsed;
  }
  listCommands(): { name: string; description: string }[] {
    return listCommands(this.pluginCommands);
  }
  async submit(text: string): Promise<void> {
    return this.executeInput(await this.prepareInput(text));
  }
  async executeInput(input: ParsedInput, context: InputContext = {}): Promise<void> {
    validateInputContext(input, context);
    if (input.kind === "compact") return this.compact(input.args);
    if (input.kind !== "prompt") throw new Error("Input must be prepared before execution");
    return this.prompt(withReferences(input.text, context.fileReferences), {
      images: context.images,
      ...(context.inputId ? { inputId: context.inputId } : {}),
    });
  }
  private async syncContext(): Promise<boolean> {
    const current = this.resources?.buildContext?.();
    if (!current) return false;
    const update = contextUpdate(this.manager.buildSessionContext().messages, {
      "zpi.base": current.base,
      ...current.sections,
    });
    if (!update) return false;
    await this.manager.appendEntryAsync({ type: "message", message: update });
    this.notifyLastEntry();
    return true;
  }
  private async refreshInstructions(): Promise<void> {
    await this.resources?.loader.reload?.();

    if (await this.syncContext()) this.agent.state.messages = this.manager.buildSessionContext().messages;
  }
  private compactionBoundary() {
    const preparation = prepareCompaction(
      this.manager.getContextEntries(),
      this.settingsManager.getCompactionSettings(this.model),
    );
    if (!preparation) throw new Error("invalid_input: 没有可压缩的完整对话内容");
    return preparation;
  }
  private estimateTokens(
    messages: AgentState["messages"],
    estimate = estimateContextTokens(messages),
  ): number {
    const source = estimate.lastUsageIndex === null ? undefined : messages[estimate.lastUsageIndex];
    if (source?.role === "assistant" && this.precedesCompaction(source)) return 0;
    return estimate.tokens;
  }
  private precedesCompaction(message: AgentState["messages"][number]): boolean {
    return this.manager.precedesCompaction(message);
  }
  private async tryAutoCompact(signal?: AbortSignal): Promise<boolean> {
    if (
      !prepareCompaction(
        this.manager.getContextEntries(),
        this.settingsManager.getCompactionSettings(this.model),
      )
    )
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
    if (this.precedesCompaction(message)) return false;
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
    const index = this.messages.findLastIndex((message) => message.role !== "system");
    const last = this.messages[index];
    if (last?.role === "assistant" && ["error", "length"].includes(last.stopReason))
      this.state.messages = this.messages.filter((_, i) => i !== index);
  }
  private async waitForRetry(
    message: Extract<AgentState["messages"][number], { role: "assistant" }>,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!this.canRetry(message)) return false;
    const settings = this.settingsManager.getRetrySettings();
    const manualRetry = message.errorDetails?.code === "MODEL_REQUEST_RETRY";
    if (manualRetry) {
      this.retryAttempt = 0;
      this.recoveryStartedAt = Date.now();
    } else this.recoveryStartedAt ??= Date.now();
    this.dropFailedAssistant();
    this.retryAttempt++;
    const delay = manualRetry
      ? 0
      : retryDelayMs(settings, this.retryAttempt, message.errorDetails?.retryAfterMs);
    this.notify({
      type: "model_retry",
      status: {
        origin: manualRetry ? "manual" : "auto",
        attempt: this.retryAttempt,
        maxRetries: settings.maxRetries,
        retryDelayMs: delay,
        errorStatus: message.errorDetails?.status ?? null,
      },
    });
    if (await this.waitForRetryDelay(delay, signal)) {
      this.recoveryStartedAt = Date.now();
      this.retryAttempt = 1;
    }
    return true;
  }
  private waitForRetryDelay(delay: number, signal?: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (this.retryCurrentRequest === retryNow) this.retryCurrentRequest = undefined;
      };
      const retryNow = () => {
        cleanup();
        resolve(true);
        return true;
      };
      const abort = () => {
        cleanup();
        reject(new DOMException("Request aborted", "AbortError"));
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(false);
      }, delay);
      this.retryCurrentRequest = retryNow;
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
    });
  }
  private canRetry(message: Extract<AgentState["messages"][number], { role: "assistant" }>): boolean {
    const settings = this.settingsManager.getRetrySettings();
    if (!this.abortRequested && message.errorDetails?.code === "MODEL_REQUEST_RETRY") return true;
    const deadline = this.recoveryDeadline(this.recoveryStartedAt ?? Date.now());
    const delay = retryDelayMs(settings, this.retryAttempt + 1, message.errorDetails?.retryAfterMs);
    return (
      !this.abortRequested &&
      !(
        !settings.enabled ||
        this.retryAttempt >= retryAttemptLimit(message, settings.maxRetries) ||
        !Number.isFinite(delay) ||
        (deadline !== undefined && Date.now() + delay >= deadline) ||
        isContextOverflowMessage(message, this.model.contextWindow) ||
        !isRetryableAssistantError(message)
      )
    );
  }
  private recoveryDeadline(startedAt = this.recoveryStartedAt): number | undefined {
    const limit = this.settingsManager.getRetrySettings().maxElapsedMs;
    return limit && limit > 0 && startedAt !== undefined ? startedAt + limit : undefined;
  }
  /** Only the active model request or retry backoff can be retried; tools keep their lifecycle. */
  retryModelRequest(): boolean {
    if (this.abortRequested || this.disposed || !this.active) return false;
    if (!this.retryCurrentRequest?.()) return false;
    this.notify({
      type: "model_retry",
      status: {
        origin: "manual",
        attempt: 1,
        maxRetries: this.settingsManager.getRetrySettings().maxRetries,
        retryDelayMs: 0,
        errorStatus: null,
      },
    });
    return true;
  }
  private requestOptions(options: SimpleStreamOptions = {}): SimpleStreamOptions {
    const request = { ...options, ...this.modelRequestOptions?.(), signal: options.signal };
    const provider = this.settingsManager.getProviderRetrySettings();
    const idle = this.settingsManager.getHttpIdleTimeoutMs();
    const requestFetch = request.fetch ?? this.runtime.fetch;
    return {
      ...provider,
      ...request,
      timeoutMs: request.timeoutMs ?? provider.timeoutMs ?? (idle === 0 ? 2147483647 : idle),
      streamIdleTimeoutMs: request.streamIdleTimeoutMs ?? this.settingsManager.getStreamIdleTimeoutMs(),
      streamFirstResponseTimeoutMs:
        request.streamFirstResponseTimeoutMs ?? this.settingsManager.getStreamFirstResponseTimeoutMs(),
      maxRetries: request.maxRetries ?? provider.maxRetries,
      maxRetryDelayMs: request.maxRetryDelayMs ?? provider.maxRetryDelayMs,
      fetch: withHttpIdleTimeout(requestFetch, idle),
    };
  }
  private alreadyCompacted(): boolean {
    const state = this.manager.getStateAt();
    return state.lastCompactionSeq > 0 && state.lastMessageSeq < state.lastCompactionSeq;
  }
  private async summarize(manual: boolean, instructions: string, signal?: AbortSignal): Promise<void> {
    const id = randomUUID();
    const origin = manual ? "manual" : "auto";
    this.notify({ type: "compaction", id, status: "running", origin });
    try {
      await this.onCompaction?.("before", { manual, instructions }, signal);
      await this.summarizeContext(manual, instructions, signal);
      await this.onCompaction?.("after", { manual, instructions }, signal);
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
      (model, context, options) => this.measuredStream(model, context, this.requestOptions(options)),
      this.settingsManager.getRetrySettings(),
      {
        onRetryScheduled: (attempt, maxRetries, retryDelayMs, _errorMessage, origin) => {
          this.notify({
            type: "model_retry",
            status: { origin, attempt, maxRetries, retryDelayMs, errorStatus: null },
          });
        },
        onRetryFinished: () => this.notify({ type: "model_retry", status: null }),
        waitBeforeRetry: (delay, signal) => this.waitForRetryDelay(delay, signal),
      },
      randomUUID(),
      this.runtime.mediaProjectionObserver(this.model, this.sessionId),
    );
    signal?.throwIfAborted();
    await this.manager.appendCompactionAsync(
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
    // If input is already ready, generate directly instead of queueing a late warmup behind it.
    clearTimeout(this.responsesWarmupTimer);
    this.responsesWarmupTimer = undefined;
    const output = createAssistantMessageEventStream();
    let partial = emptyAssistant(model);
    void (async () => {
      const response = this.measuredStream(
        model,
        context,
        this.requestOptions({
          ...options,
          sessionId: this.sessionId,
          ...(this.responsesSession ? { responsesSession: this.responsesSession } : {}),
          streamDeadlineMs:
            options.streamDeadlineMs ?? (this.retryAttempt > 0 ? this.recoveryDeadline() : undefined),
        }),
      );
      let started = false;
      for await (const event of response) {
        partial =
          event.type === "error" ? event.error : event.type === "done" ? event.message : event.partial;
        if (event.type === "start") {
          started = true;
          // The response stream is connected again; keep the retry budget until
          // the message succeeds, but stop showing the reconnect indicator now.
          if (this.retryAttempt > 0) this.notify({ type: "model_retry", status: null });
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
  private measuredStream(model: Model, context: TranscriptContext, options: SimpleStreamOptions) {
    const output = createAssistantMessageEventStream();
    const request = this.performance.request(model, options.reasoning);
    const retry = new AbortController();
    const retryNow = () => {
      if (retry.signal.aborted || options.signal?.aborted) return false;
      retry.abort(new ModelRequestRetryError());
      return true;
    };
    this.retryCurrentRequest = retryNow;
    void (async () => {
      try {
        const response = this.runtime.streamSimple(model, context, {
          ...options,
          onPerformance: request.update,
          retrySignal: retry.signal,
          onModelWait: (status) => this.notify({ type: "model_wait", status }),
        });
        for await (const event of response) {
          if (event.type === "done" || event.type === "error") {
            if (this.retryCurrentRequest === retryNow) this.retryCurrentRequest = undefined;
            request.finish(
              event.type === "done" && event.reason !== "length" && !options.signal?.aborted,
              event.type === "done" ? event.message : event.error,
            );
          }
          output.push(event);
        }
      } catch (error) {
        const failure = emptyAssistant(model);
        failure.stopReason = options.signal?.aborted ? "aborted" : "error";
        failure.errorMessage = error instanceof Error ? error.message : String(error);
        output.end(failure);
      } finally {
        if (this.retryCurrentRequest === retryNow) this.retryCurrentRequest = undefined;
        request.finish(false);
      }
    })();
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
    this.active = "compact";
    this.performance.begin();
    this.abortRequested = false;
    this.retryAttempt = 0;
    this.recoveryStartedAt = undefined;
    const controller = new AbortController();
    this.compactController = controller;
    this.running = (async () => {
      await this.resources?.loader.reload?.();
      await this.summarize(true, instructions, controller.signal);
      this.state.messages = this.manager.buildSessionContext().messages;
    })().finally(() => {
      this.performance.settle();
      this.compactController = undefined;
      this.retryCurrentRequest = undefined;
      this.notify({ type: "model_retry", status: null });
      this.notify({ type: "model_wait", status: null });
      this.active = undefined;
      this.running = undefined;
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
    return this.manager.getCurrentState().name;
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
  prompt(text: string, options: { images?: ImageContent[]; inputId?: string } = {}): Promise<void> {
    try {
      this.idleCheck();
      assertSupportedOptions(options, ["images", "inputId"], "Session.prompt");
      this.validateImages(options.images);
    } catch (e) {
      return Promise.reject(e);
    }
    this.active = "prompt";
    this.hooks.beginRun();
    this.performance.begin();
    this.abortRequested = false;
    this.overflowRecoveryAttempted = false;
    this.retryAttempt = 0;
    this.recoveryStartedAt = undefined;
    this.compactController = new AbortController();
    this.running = Promise.resolve()
      .then(async () => {
        if (this.abortRequested) return;
        const signal = this.compactController?.signal;
        const hookMessages = await this.hooks.preparePrompt(text, signal);
        if (signal?.aborted) return;
        await this.refreshInstructions();
        if (signal?.aborted) return;
        await this.checkCompaction(signal, true);
        if (signal?.aborted) return;
        await this.agent.prompt([
          ...hookMessages,
          {
            role: "user",
            content: options.images?.length ? [{ type: "text", text }, ...options.images] : text,
            timestamp: Date.now(),
            ...(options.inputId ? { inputId: options.inputId } : {}),
          },
        ]);
        while (!signal?.aborted) {
          const last = this.messages.findLast((message) => message.role === "assistant");
          if (last?.role === "assistant" && (await this.waitForRetry(last, signal))) {
            // 失败请求已结束，重试必须先接入待引导输入，不能一直用旧上下文重试。
            if (this.steering.length) await this.agent.prompt(this.steering.splice(0));
            else await this.agent.continue();
            continue;
          }
          if (this.steering.length) {
            await this.agent.prompt(this.steering.splice(0));
            continue;
          }
          const compacted = await this.checkCompaction(signal);
          if (!signal?.aborted && this.steering.length) {
            await this.agent.prompt(this.steering.splice(0));
            continue;
          }
          if (!compacted) break;
          await this.agent.continue();
        }
      })
      .catch((error) => {
        if (!this.abortRequested) throw error;
      })
      .finally(() => {
        this.performance.settle();
        this.compactController = undefined;
        this.notify({ type: "model_retry", status: null });
        this.notify({ type: "model_wait", status: null });
        this.retryCurrentRequest = undefined;
        this.active = undefined;
        this.running = undefined;
        this.steering = [];
        this.pendingMessages = [];
        this.notify({ type: "agent_settled" });
      });
    return this.running;
  }
  /** Queue input for the next completed model/tool boundary without interrupting generation. */
  steer(
    text: string,
    options: {
      queueOnly?: boolean;
      inputId?: string;
      userGuide?: UserGuide;
      images?: ImageContent[];
      fileReferences?: string[];
    } = {},
  ): boolean {
    this.validateImages(options.images);
    if ((!text.trim() && !options.images?.length) || (!options.queueOnly && text.length > 100000))
      throw new Error("Invalid steering input");
    if (this.active !== "prompt" || this.disposed || this.abortRequested) return false;
    (options.queueOnly ? this.pendingMessages : this.steering).push({
      role: "user",
      content: options.images?.length
        ? [{ type: "text", text: withReferences(text, options.fileReferences) }, ...options.images]
        : withReferences(text, options.fileReferences),
      timestamp: Date.now(),
      ...(options.inputId ? { inputId: options.inputId } : {}),
      ...(options.userGuide ? { userGuide: options.userGuide } : {}),
    });
    return true;
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
    clearTimeout(this.responsesWarmupTimer);
    this.responsesWarmupController?.abort();
    this.responsesSession?.dispose();
    this.performance.dispose();
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
    const changed =
      model.provider !== this.model.provider ||
      model.id !== this.model.id ||
      model.api !== this.model.api ||
      model.baseUrl !== this.model.baseUrl ||
      model.auth !== this.model.auth;
    if (model.provider !== this.model.provider || model.id !== this.model.id) {
      if (this.manager.appendModelChange(model.provider, model.id)) this.notifyLastEntry();
    }
    this.state.model = model;
    const thinkingLevel = clampThinkingLevel(model, this.thinkingLevel);
    if (thinkingLevel !== this.thinkingLevel) this.setThinkingLevel(thinkingLevel);
    if (changed) this.prepareResponsesSession();
  }
  setThinkingLevel(thinkingLevel: ThinkingLevel): void {
    this.idleCheck();
    const changed = thinkingLevel !== this.thinkingLevel;
    const entryId = this.manager.appendThinkingLevelChange(thinkingLevel);
    this.state.thinkingLevel = thinkingLevel;
    if (entryId) this.notifyLastEntry();
    this.notify({ type: "thinking_level_changed", thinkingLevel });
    if (changed && (this.responsesWarmupTimer || this.responsesWarmupController))
      this.prepareResponsesSession();
  }
  setSessionName(name: string): void {
    this.idleCheck();
    if (this.manager.appendSessionInfo(name)) this.notifyLastEntry();
    this.notify({ type: "session_info_changed", name });
  }
}

function initialSystemMessages(
  manager: SessionManager,
  activeTools: AgentTool[],
  systemPrompt: string,
  context?: SystemContext,
): Extract<Message, { role: "system" }>[] {
  const messages: Extract<Message, { role: "system" }>[] = [];
  const restored = manager.buildSessionContext();
  // Restored plugin readers may not be prepared until the prompt hooks run.
  // Keep the last effective state until that boundary instead of withdrawing it at startup.
  if (restored.messages.some((m) => m.role === "system")) return messages;
  messages.push({
    role: "system",
    content: "",
    sections: { "zpi.base": systemPrompt },
    toolsAdded: activeTools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    })),
    timestamp: Date.now(),
  });
  if (context) {
    const update = contextUpdate([...restored.messages, ...messages], {
      "zpi.base": context.base,
      ...context.sections,
    });
    if (update) messages.push(update);
  }
  return messages;
}
