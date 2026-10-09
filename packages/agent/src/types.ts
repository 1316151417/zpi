import type {
  AssistantMessage,
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ImageContent,
  JsonValue,
  Message,
  Model,
  SimpleStreamOptions,
  TextContent,
  Tool,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
} from "ZPI-ai";
import type { Static, TSchema } from "typebox";
// biome-ignore lint/suspicious/noEmptyInterface: Public declaration merging extension point.
export interface CustomAgentMessages {}
export type AgentMessage = Message | CustomAgentMessages[keyof CustomAgentMessages];
export type ThinkingLevel = "off" | import("ZPI-ai").ThinkingLevel;
export type ToolExecutionMode = "sequential" | "parallel";
export interface ToolExecutionMetadata {
  readOnly?: boolean;
  concurrentSafe?: boolean;
  destructive?: boolean;
  needsApproval?: boolean;
  requiresUserInteraction?: boolean;
  sideEffectScope?: "none" | "workspace" | "git" | "network" | "system" | "session" | "userInteraction";
}
export type StreamFn = (
  model: Model,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>;
export interface AgentToolResult<T = JsonValue | undefined> {
  content: (TextContent | ImageContent)[];
  details: T;
  isError?: boolean;
  structuredContent?: JsonValue;
}
export type AgentToolUpdateCallback<T = JsonValue | undefined> = (partialResult: AgentToolResult<T>) => void;
export interface AgentTool<TParameters extends TSchema = TSchema, TDetails = JsonValue | undefined>
  extends Tool<TParameters> {
  label: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  executionMode?: ToolExecutionMode;
  metadata?: ToolExecutionMetadata;
  permission?: { sideEffectScope?: ToolExecutionMetadata["sideEffectScope"] };
  requiresUserInteraction?: boolean;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal?: AbortSignal,
    onUpdate?: AgentToolUpdateCallback<TDetails>,
  ): Promise<AgentToolResult<TDetails>>;
}
export interface AgentContext {
  messages: AgentMessage[];
  tools?: AgentTool[];
}
export interface PrepareNextTurnContext {
  message: AssistantMessage;
  toolResults: ToolResultMessage[];
  context: AgentContext;
  newMessages: AgentMessage[];
}
export interface AgentLoopTurnUpdate {
  context?: AgentContext;
}
export interface BeforeToolCallContext {
  assistantMessage: AssistantMessage;
  toolCall: ToolCall;
  args: unknown;
  context: AgentContext;
}
export interface BeforeToolCallResult {
  block?: boolean;
  reason?: string;
}
export interface AfterToolCallContext extends BeforeToolCallContext {
  result: AgentToolResult;
  isError: boolean;
}
export interface AfterToolCallResult {
  content?: (TextContent | ImageContent)[];
  details?: JsonValue;
  isError?: boolean;
}
export interface AgentLoopConfig extends SimpleStreamOptions {
  model: Model;
  convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  transformContext?: (messages: AgentMessage[], signal?: AbortSignal) => Promise<AgentMessage[]>;
  getApiKey?: (provider: string) => string | undefined | Promise<string | undefined>;
  beforeToolCall?: (
    context: BeforeToolCallContext,
    signal?: AbortSignal,
  ) => Promise<BeforeToolCallResult | undefined>;
  afterToolCall?: (
    context: AfterToolCallContext,
    signal?: AbortSignal,
  ) => Promise<AfterToolCallResult | undefined>;
  toolExecution?: ToolExecutionMode;
  streamingToolExecution?: "off" | "readOnly";
  prepareNextTurnWithContext?: (
    turn: PrepareNextTurnContext,
    signal?: AbortSignal,
  ) => Promise<AgentLoopTurnUpdate | undefined>;
}
export type AgentEvent =
  | { type: "agent_start" }
  | { type: "agent_end"; messages: AgentMessage[] }
  | { type: "turn_start" }
  | { type: "turn_end"; message: AgentMessage; toolResults: ToolResultMessage[] }
  | { type: "message_start" | "message_end"; message: AgentMessage }
  | { type: "message_update"; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      executionTiming?: "during_stream";
    }
  | {
      type: "tool_execution_update";
      toolCallId: string;
      toolName: string;
      args: unknown;
      partialResult: AgentToolResult;
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: string;
      result: AgentToolResult;
      isError: boolean;
    };
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;
export interface AgentState {
  readonly systemPrompt: string;
  model: Model;
  thinkingLevel: ThinkingLevel;
  messages: AgentMessage[];
  tools: AgentTool[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
export type AgentInitialState = Partial<
  Omit<AgentState, "isStreaming" | "streamingMessage" | "pendingToolCalls" | "errorMessage">
>;
export interface AgentOptions
  extends Pick<
    AgentLoopConfig,
    | "transformContext"
    | "getApiKey"
    | "beforeToolCall"
    | "afterToolCall"
    | "onPayload"
    | "onResponse"
    | "toolExecution"
    | "streamingToolExecution"
    | "prepareNextTurnWithContext"
  > {
  initialState?: AgentInitialState;
  streamFn: StreamFn;
  convertToLlm?: AgentLoopConfig["convertToLlm"];
}
