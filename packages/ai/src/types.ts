import type { TSchema } from "typebox";
import type { AssistantMessageEventStream } from "./utils/event-stream.ts";

export type { AssistantMessageEventStream } from "./utils/event-stream.ts";
export type ProviderApi = "anthropic-messages" | "openai-completions" | "openai-responses";
export type Api = ProviderApi | (string & {});
export type CacheRetention = "none" | "short" | "long";
export type ProviderEnv = Record<string, string>;
export type ProviderHeaders = Record<string, string | null>;
export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}
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

/** Compatibility settings for Anthropic Messages-compatible APIs. */
export interface AnthropicMessagesCompat {
  /**
   * Whether the provider accepts per-tool `eager_input_streaming`.
   * When false, the Anthropic provider omits `tools[].eager_input_streaming`
   * and sends the legacy `fine-grained-tool-streaming-2025-05-14` beta header
   * for tool-enabled requests.
   * Default: true.
   */
  supportsEagerToolInputStreaming?: boolean;
  /** Whether the provider supports Anthropic long cache retention (`cache_control.ttl: "1h"`). Default: true. */
  supportsLongCacheRetention?: boolean;
  /**
   * Whether to send the `x-session-affinity` header from `options.sessionId`
   * when caching is enabled. Required for providers like Fireworks that use
   * session affinity for prompt cache routing (requests to the same replica
   * maximize cache hits).
   * Default: false.
   */
  sendSessionAffinityHeaders?: boolean;
  /** Session-affinity format. `"openrouter"` sends `x-session-id`; when unset, sends `x-session-affinity`. */
  sessionAffinityFormat?: "openrouter";
  /**
   * Whether the provider supports Anthropic-style `cache_control` markers on
   * tool definitions. When false, `cache_control` is omitted from tool params.
   * Some Anthropic-compatible providers (e.g., Fireworks) do not support this
   * field on tools and may reject or ignore it.
   * Default: true.
   */
  supportsCacheControlOnTools?: boolean;
  /**
   * Whether the model accepts the Anthropic `temperature` request field.
   * Claude Opus 4.7+ rejects non-default temperature values.
   * Default: true.
   */
  supportsTemperature?: boolean;
  /**
   * Whether to force adaptive thinking (`thinking.type: "adaptive"` plus
   * `output_config.effort`) regardless of the model id. Built-in models that
   * require adaptive thinking set this in generated metadata. Custom
   * Anthropic-compatible providers can set this to `true` for any model whose
   * upstream requires the adaptive format. Set to `false` to
   * opt out on overridden built-in models.
   * Default: false.
   */
  forceAdaptiveThinking?: boolean;
  /** Whether to replay empty thinking signatures as `signature: ""` instead of converting thinking to text. Default: false. */
  allowEmptySignature?: boolean;
  /** Whether the provider supports Anthropic strict tool schemas. Default: false; generated Anthropic models enable it explicitly. */
  supportsStrictTools?: boolean;
  /** Whether the exact model transport supports effort-only system messages and thinking binding controls. Default: false. */
  supportsMidConvoEffort?: boolean;
  /** Whether the exact model accepts system-role messages inside the conversation. When false, later system messages are folded into the top-level system prompt. Default: false. */
  supportsMidConvoSystemMessages?: boolean;
  /** Whether the exact model accepts mid-conversation `tool_addition` and `tool_removal` blocks. Requires `supportsMidConvoSystemMessages`. Default: false. */
  supportsMidConvoToolChanges?: boolean;
  /**
   * Models Anthropic accepts in `fallbacks` for server-side refusal fallback,
   * with local pricing metadata for returned fallback responses. When absent or
   * empty, callers must omit `fallbacks`; Anthropic rejects the field for models
   * with no permitted fallback targets.
   */
  allowedFallbackModels?: AnthropicAllowedFallbackModel[];
}

export interface AnthropicAllowedFallbackModel {
  provider: string;
  model: string;
  cost: Model["cost"];
}
export type ModelCompat = OpenAICompletionsCompat & AnthropicMessagesCompat;
export const anthropicMessagesCompatKeys = [
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "sendSessionAffinityHeaders",
  "sessionAffinityFormat",
  "supportsCacheControlOnTools",
  "supportsTemperature",
  "forceAdaptiveThinking",
  "allowEmptySignature",
  "supportsStrictTools",
  "supportsMidConvoEffort",
  "supportsMidConvoSystemMessages",
  "supportsMidConvoToolChanges",
  "allowedFallbackModels",
] as const satisfies readonly (keyof AnthropicMessagesCompat)[];

export interface Model<TApi extends Api = Api> {
  id: string;
  name: string;
  api: TApi;
  provider: string;
  baseUrl: string;
  auth?: "chatgpt";
  input: ("text" | "image")[];
  reasoning: boolean;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    tiers?: {
      inputTokensAbove: number;
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
    }[];
  };
  contextWindow: number;
  maxTokens: number;
  headers?: Record<string, string>;
  compat?: ModelCompat;
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
  constrainedSampling?: { type: "json_schema"; strict: "prefer" | "require" };
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
  cacheWrite1h?: number;
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
  diagnostics?: import("./utils/diagnostics.ts").AssistantMessageDiagnostic[];
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
  cacheRetention?: CacheRetention;
  metadata?: Record<string, unknown>;
  env?: ProviderEnv;
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
  thinkingBudgets?: ThinkingBudgets;
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
