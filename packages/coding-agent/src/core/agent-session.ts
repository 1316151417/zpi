import type { AgentEvent, AgentState, AgentTool, ThinkingLevel } from "ZPI-agent";
import { Agent } from "ZPI-agent";
import type {
  ContextUsageAnchor,
  ImageContent,
  Model,
  ModelRetryStatus,
  SimpleStreamOptions,
  TranscriptContext,
} from "ZPI-ai";
import {
  assertSupportedOptions,
  createAssistantMessageEventStream,
  emptyAssistant,
  estimateContextTokens,
  messageChars,
  normalizeContext,
  restoreUsageAnchor,
  usageAnchor,
} from "ZPI-ai";
import { randomUUID } from "node:crypto";
import type { ParsedInput } from "./commands.ts";
import { parseInput } from "./commands.ts";
import {
  type CompactionOptions,
  compactionBoundary,
  fileLists,
  isContextOverflow,
  serializeConversation,
  summaryPrompt,
} from "./compaction.ts";
import type { ModelRuntime } from "./model-runtime.ts";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionEntry, SessionManager } from "./session-manager.ts";
import type { ContextUsage } from "./session-state.ts";
import { contextUsage } from "./session-state.ts";
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
  | { type: "agent_end"; messages: AgentState["messages"]; willRetry: false }
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
    compaction?: CompactionOptions;
  };
  private compactController?: AbortController;
  private usageAnchor?: ContextUsageAnchor;
  private autoCompactionAttempted = false;
  private streamRecoveryRetries = 0;
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
      compaction?: CompactionOptions;
    },
  ) {
    this.manager = manager;
    this.runtime = runtime;
    this.resources = resources;
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
      streamFn: (m, c, o) => this.streamWithCompaction(m, c, o),
      transformContext: async (_messages, signal) => {
        const messages = this.manager.buildSessionContext().messages;
        const threshold = Math.max(
          1,
          this.model.contextWindow - (this.resources?.compaction?.reserveTokens ?? 16384),
        );
        if (!this.autoCompactionAttempted && estimateContextTokens(messages, this.usageAnchor) > threshold) {
          this.autoCompactionAttempted = true;
          try {
            await this.summarize(false, "", signal);
            return this.manager.buildSessionContext().messages;
          } catch (error) {
            if (signal?.aborted) throw error;
            this.notify({ type: "command_result", message: "自动压缩失败，保留原上下文。" });
          }
        }
        return messages;
      },
      toolExecution: "sequential",
    });
    this.usageAnchor = restoreUsageAnchor(this.agent.state.messages);
    this.agent.subscribe((event) => {
      if (event.type === "message_end") {
        try {
          this.manager.appendMessage(event.message);
          this.notifyLastEntry();
        } catch (e) {
          this.fault = e instanceof Error ? e : new Error(String(e));
          this.agent.abort();
          throw this.fault;
        }
      }
      this.notify(event.type === "agent_end" ? { ...event, willRetry: false } : event);
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
    return this.resources?.loader.getDiagnostics?.() ?? [];
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
  private compactionBoundary(manual = true, force = false) {
    const keep = this.resources?.compaction?.keepRecentTokens ?? 20000;
    const boundary = compactionBoundary(
      this.manager,
      force
        ? Math.min(
            keep,
            Math.max(
              1,
              Math.floor(
                this.manager
                  .buildSessionContext()
                  .messages.reduce((n, m) => n + (m.role === "system" ? 0 : messageChars(m)), 0) / 8,
              ),
            ),
          )
        : keep,
      manual,
    );
    if (!boundary) throw new Error("invalid_input: 至少需要两个完整对话回合才能压缩，最近一个回合会保留");
    return boundary;
  }
  private alreadyCompacted(): boolean {
    const entries = this.manager.getEntries();
    const last = entries.findLastIndex((entry) => entry.type === "compaction");
    return last >= 0 && !entries.slice(last + 1).some((entry) => entry.type === "message");
  }
  private async summarize(
    manual: boolean,
    instructions: string,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    const id = randomUUID();
    const origin = manual ? "manual" : "auto";
    this.notify({ type: "compaction", id, status: "running", origin });
    try {
      await this.summarizeContext(manual, instructions, signal, force);
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
  private async summarizeContext(
    manual: boolean,
    instructions: string,
    signal?: AbortSignal,
    force = false,
  ): Promise<void> {
    signal?.throwIfAborted();
    const { older, firstKeptEntryId, entries } = this.compactionBoundary(manual, force);
    const response = this.runtime.streamSimple(
      this.model,
      normalizeContext({
        messages: [
          { role: "system", content: summaryPrompt, timestamp: Date.now() },
          {
            role: "user",
            content: `Additional instructions: ${instructions || "none"}\nConversation:\n${serializeConversation(older)}`,
            timestamp: Date.now(),
          },
        ],
      }),
      {
        signal,
        sessionId: `${this.sessionId}:compact`,
        maxTokens: Math.min(this.model.maxTokens, this.resources?.compaction?.reserveTokens ?? 16384),
        reasoning: this.thinkingLevel,
      },
    );
    for await (const _event of response) {
      /* Independent summary stream, never a chat reply. */
    }
    const result = await response.result();
    signal?.throwIfAborted();
    if (result.stopReason !== "stop")
      throw new Error(result.errorMessage ?? `provider: 压缩失败 (${result.stopReason})`);
    const summary = result.content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("\n")
      .trim();
    if (!summary) throw new Error("provider: 压缩返回空摘要");
    this.manager.appendCompaction(summary + fileLists(entries), firstKeptEntryId);
    this.notifyLastEntry();
    this.usageAnchor = undefined;
    this.notify({
      type: "command_result",
      message: manual
        ? "上下文已压缩；完整历史保留，下一次请求使用摘要和最近回合。"
        : "上下文接近容量，已自动压缩。",
    });
  }
  private streamWithCompaction(model: Model, context: TranscriptContext, options: SimpleStreamOptions = {}) {
    options = {
      ...options,
      sessionId: this.sessionId,
      onRetry: (status) => this.notify({ type: "model_retry", status }),
    };
    const output = createAssistantMessageEventStream();
    void (async () => {
      let request = context;
      let messageStarted = false;
      for (;;) {
        const response = this.runtime.streamSimple(model, request, options);
        let started = false;
        let emitted = false;
        let recover = false;
        for await (const event of response) {
          // Hold the empty start so a rejected overflowing request never creates a ghost reply.
          if (event.type === "start") {
            started = true;
            continue;
          }
          if (
            event.type === "error" &&
            emitted &&
            !options.signal?.aborted &&
            event.error.errorDetails?.retryable &&
            this.streamRecoveryRetries < 10
          ) {
            recover = true;
            break;
          }
          if (
            event.type === "error" &&
            !emitted &&
            !this.autoCompactionAttempted &&
            !options.signal?.aborted &&
            isContextOverflow(event.error.errorMessage ?? "")
          )
            break;
          if (started && !messageStarted) {
            output.push({
              type: "start",
              partial:
                event.type === "done" ? event.message : event.type === "error" ? event.error : event.partial,
            });
            messageStarted = true;
          }
          emitted = true;
          output.push(event);
        }
        const result = await response.result();
        if (recover) {
          // ZCode 从最后一个安全锚点恢复，不能把断流前的正文/思考与新回复拼接。
          // ZPI 的工具在完整模型消息后执行；只保留完整调用，执行一次后带结果继续。
          const recovered = emptyAssistant(model);
          recovered.content = result.content.filter((c) => c.type === "toolCall");
          this.streamRecoveryRetries++;
          options.onRetry?.({
            attempt: this.streamRecoveryRetries,
            maxRetries: 10,
            retryDelayMs: 0,
            errorStatus: result.errorDetails?.status ?? null,
          });
          output.push({ type: "reset", partial: recovered });
          if (recovered.content.length) {
            for (const [contentIndex, toolCall] of recovered.content.entries()) {
              if (toolCall.type !== "toolCall") continue;
              output.push({ type: "toolcall_start", contentIndex, partial: recovered });
              output.push({ type: "toolcall_end", contentIndex, toolCall, partial: recovered });
            }
            recovered.stopReason = "toolUse";
            output.end(recovered);
            return;
          }
          continue;
        }
        if (emitted) {
          this.usageAnchor = usageAnchor(request.messages, result) ?? this.usageAnchor;
          return;
        }
        this.autoCompactionAttempted = true;
        try {
          await this.summarize(false, "", options.signal, true);
        } catch {
          output.end(result);
          return;
        }
        request = normalizeContext({ messages: this.manager.buildSessionContext().messages });
      }
    })().catch((error: unknown) => {
      const result = emptyAssistant(model);
      result.stopReason = options.signal?.aborted ? "aborted" : "error";
      result.errorMessage = error instanceof Error ? error.message : String(error);
      options.onRetry?.(null);
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
    this.autoCompactionAttempted = false;
    this.streamRecoveryRetries = 0;
    this.running = Promise.resolve()
      .then(async () => {
        await this.refreshInstructions();
        if (this.abortRequested) return;
        const run = this.agent.prompt(text, options.images);
        if (this.abortRequested) this.agent.abort();
        await run;
        this.state.messages = this.manager.buildSessionContext().messages;
      })
      .finally(() => {
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
    this.usageAnchor = undefined;
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
