import type { TSchema } from "typebox";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";
export type Api = "openai-completions" | "openai-responses" | (string & {});
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export type JsonObject = { [key: string]: JsonValue };
export type ThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | (string & {});
export interface ReasoningConfig {
  levels: string[];
  map: string;
}
export interface OpenAICompletionsCompat {
  thinkingFormat?: "deepseek" | "zai";
  structuredOutput?: "prompt" | "json_object" | "json_schema";
  maxTokensField?: "max_tokens" | "max_completion_tokens";
  supportsDeveloperRole?: boolean;
  supportsReasoningEffort?: boolean;
  supportsUsageInStreaming?: boolean;
  requiresReasoningContentOnAssistantMessages?: boolean;
}
export const openAICompletionsCompatKeys = [
  "thinkingFormat",
  "structuredOutput",
  "maxTokensField",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "requiresReasoningContentOnAssistantMessages",
] as const satisfies readonly (keyof OpenAICompletionsCompat)[];

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  auth?: "chatgpt";
  input: ("text" | "image")[];
  reasoning: boolean;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: OpenAICompletionsCompat;
  thinkingLevelMap?: Partial<Record<"off" | ThinkingLevel, string | JsonObject | null>>;
  reasoningConfig?: ReasoningConfig;
  defaultThinkingLevel?: "off" | ThinkingLevel;
  samplingParams?: Record<string, unknown>;
}
export interface TextContent {
  type: "text";
  text: string;
  textSignature?: string;
}
export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  thinkingSignature?: string;
  redacted?: boolean;
}
export interface ImageContent {
  type: "image";
  data: string;
  mimeType: string;
}
export interface ToolCall {
  type: "toolCall";
  id: string;
  name: string;
  arguments: JsonObject;
  thoughtSignature?: string;
  namespace?: string;
}
export interface Tool<TParameters extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParameters;
}
export interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  timestamp: number;
  sections?: Record<string, string | null>;
  toolsAdded?: Tool[];
  toolsRemoved?: { name: string }[];
}
export interface UserMessage {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp: number;
}
export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  reasoning?: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}
export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
export interface ContextBreakdownItem {
  source: "messages" | "system_tools" | "system_prompt" | "skills" | "other";
  chars: number;
}
export interface AssistantMessage {
  role: "assistant";
  content: (TextContent | ThinkingContent | ToolCall)[];
  api: Api;
  provider: string;
  model: string;
  responseModel?: string;
  responseId?: string;
  providerThinkingLevel?: string;
  thinkingLevel?: "off" | ThinkingLevel;
  usage: Usage;
  usageAvailable?: boolean;
  cacheUsageAvailable?: boolean;
  contextBreakdown?: ContextBreakdownItem[];
  stopReason: StopReason;
  errorMessage?: string;
  errorDetails?: ModelFailure;
  rawStopReason?: string;
  endTurn?: boolean;
  timestamp: number;
}
export interface ModelFailure {
  retryable: boolean;
  status?: number;
  retryAfterMs?: number;
}
export interface ModelRetryStatus {
  attempt: number;
  maxRetries: number;
  retryDelayMs: number;
  errorStatus: number | null;
}
export interface ToolResultMessage {
  role: "toolResult";
  toolCallId: string;
  toolName: string;
  content: (TextContent | ImageContent)[];
  details?: JsonValue;
  isError: boolean;
  timestamp: number;
}
export type Message = SystemMessage | UserMessage | AssistantMessage | ToolResultMessage;
export interface Context {
  systemPrompt?: string;
  messages: Message[];
  tools?: Tool[];
}
declare const transcriptBrand: unique symbol;
export type TranscriptContext = { messages: Message[]; readonly [transcriptBrand]: true };
export interface StreamOptions {
  signal?: AbortSignal;
  sessionId?: string;
  apiKey?: string;
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string | null>;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  maxRetries?: number;
  maxRetryDelayMs?: number;
  onRetry?: (status: ModelRetryStatus | null) => void;
  samplingParams?: Record<string, unknown>;
  onPayload?: (payload: unknown, model: Model) => unknown | undefined | Promise<unknown | undefined>;
  onResponse?: (
    response: { status: number; headers: Record<string, string> },
    model: Model,
  ) => void | Promise<void>;
}
export interface SimpleStreamOptions extends StreamOptions {
  reasoning?: "off" | ThinkingLevel;
  toolChoice?: "auto" | "none";
}
export type StreamFunction<TApi extends Api = Api, TOptions extends StreamOptions = StreamOptions> = (
  model: Model<TApi>,
  context: TranscriptContext,
  options?: TOptions,
) => AssistantMessageEventStream;
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "reset"; partial: AssistantMessage }
  | {
      type: "text_start" | "thinking_start" | "toolcall_start";
      contentIndex: number;
      partial: AssistantMessage;
    }
  | {
      type: "text_delta" | "thinking_delta" | "toolcall_delta";
      contentIndex: number;
      delta: string;
      partial: AssistantMessage;
    }
  | { type: "text_end" | "thinking_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "toolcall_end"; contentIndex: number; toolCall: ToolCall; partial: AssistantMessage }
  | { type: "done"; reason: "stop" | "length" | "toolUse"; message: AssistantMessage }
  | { type: "error"; reason: "error" | "aborted"; error: AssistantMessage };
