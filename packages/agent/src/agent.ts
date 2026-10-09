import type { ImageContent, Message, UserMessage } from "ZPI-ai";
import { assertSupportedOptions, getCurrentSystemPrompt, toToolDeclaration } from "ZPI-ai";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import type { AgentEvent, AgentMessage, AgentOptions, AgentState, PrepareNextTurnContext } from "./types.ts";
export class Agent {
  readonly state: AgentState;
  private options: AgentOptions;
  private listeners = new Set<(event: AgentEvent) => void | Promise<void>>();
  private controller?: AbortController;
  private running?: Promise<void>;
  private active = false;
  private partial?: AgentMessage;
  private pending = new Set<string>();
  private error?: string;
  constructor(options: AgentOptions) {
    assertSupportedOptions(
      options,
      [
        "initialState",
        "streamFn",
        "convertToLlm",
        "transformContext",
        "getApiKey",
        "beforeToolCall",
        "afterToolCall",
        "onPayload",
        "onResponse",
        "toolExecution",
        "streamingToolExecution",
        "prepareNextTurnWithContext",
      ],
      "Agent",
    );
    if (typeof options.streamFn !== "function") throw new Error("Agent requires streamFn");
    this.options = options;
    const initial = options.initialState ?? {};
    assertSupportedOptions(
      initial,
      ["model", "messages", "tools", "systemPrompt", "thinkingLevel"],
      "initialState",
    );
    // No implicit default model: fail before accepting work.
    if (!initial.model) throw new Error("Agent requires an initial model");
    let messages = [...(initial.messages ?? [])];
    let tools = [...(initial.tools ?? [])];
    if (messages[0]?.role !== "system" && (initial.systemPrompt || tools.length))
      messages.unshift({
        role: "system",
        content: initial.systemPrompt ?? "",
        toolsAdded: tools.map(toToolDeclaration),
        timestamp: 0,
      });
    const self = this;
    this.state = {
      model: initial.model,
      thinkingLevel: initial.thinkingLevel ?? "off",
      get systemPrompt() {
        return getCurrentSystemPrompt(messages);
      },
      get messages() {
        return messages;
      },
      set messages(value) {
        if (self.active) throw new Error("Agent busy");
        messages = [...value];
      },
      get tools() {
        return tools;
      },
      set tools(value) {
        if (self.active) throw new Error("Agent busy");
        tools = [...value];
      },
      get isStreaming() {
        return self.active;
      },
      get streamingMessage() {
        return self.partial;
      },
      get pendingToolCalls() {
        return self.pending;
      },
      get errorMessage() {
        return self.error;
      },
    };
  }
  get signal(): AbortSignal | undefined {
    return this.controller?.signal;
  }
  subscribe(listener: (event: AgentEvent) => void | Promise<void>): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  abort(): void {
    this.controller?.abort();
  }
  async waitForIdle(): Promise<void> {
    await this.running;
  }
  prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    const prompts: AgentMessage[] =
      typeof input === "string"
        ? [
            {
              role: "user",
              content: images?.length ? [{ type: "text", text: input }, ...images] : input,
              timestamp: Date.now(),
            } satisfies UserMessage,
          ]
        : Array.isArray(input)
          ? input
          : [input];
    return this.start(prompts);
  }
  continue(): Promise<void> {
    return this.start();
  }
  private start(prompts?: AgentMessage[]): Promise<void> {
    if (this.active) return Promise.reject(new Error("Agent busy: a run is already active"));
    this.active = true;
    this.error = undefined;
    this.controller = new AbortController();
    const { initialState: _, streamFn: __, ...loopOptions } = this.options;
    const config = {
      ...loopOptions,
      model: this.state.model,
      convertToLlm:
        this.options.convertToLlm ??
        ((messages: AgentMessage[]) =>
          messages.filter((m) =>
            ["system", "user", "assistant", "toolResult"].includes(m.role),
          ) as Message[]),
      reasoning: this.state.thinkingLevel,
      prepareNextTurnWithContext: this.options.prepareNextTurnWithContext
        ? async (turn: PrepareNextTurnContext, signal?: AbortSignal) => {
            const next = await this.options.prepareNextTurnWithContext?.(turn, signal);
            if (next?.context)
              this.state.messages.splice(0, this.state.messages.length, ...next.context.messages);
            return next;
          }
        : undefined,
    };
    const emit = async (event: AgentEvent): Promise<void> => {
      if (event.type === "message_start" && event.message.role === "assistant") this.partial = event.message;
      if (event.type === "message_update") this.partial = event.message;
      if (event.type === "message_end") {
        this.state.messages.push(event.message);
        this.partial = undefined;
        if (event.message.role === "assistant") this.error = event.message.errorMessage;
      }
      if (event.type === "tool_execution_start") this.pending.add(event.toolCallId);
      if (event.type === "tool_execution_end") this.pending.delete(event.toolCallId);
      try {
        for (const listener of this.listeners) await listener(event);
      } catch (error) {
        // A streamed tool can fail its sink while the provider is still generating.
        this.controller?.abort();
        throw error;
      }
    };
    const context = { messages: [...this.state.messages], tools: [...this.state.tools] };
    // Defer entry so running is installed before any callback can observe it.
    this.running = Promise.resolve()
      .then(async () => {
        if (prompts)
          await runAgentLoop(prompts, context, config, emit, this.controller?.signal, this.options.streamFn);
        else
          await runAgentLoopContinue(context, config, emit, this.controller?.signal, this.options.streamFn);
      })
      .finally(() => {
        this.active = false;
        this.partial = undefined;
        this.pending.clear();
        this.controller = undefined;
      });
    return this.running;
  }
}
