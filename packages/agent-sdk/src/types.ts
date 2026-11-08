import type {
  AgentSession,
  InputContext,
  ModelRuntime,
  ParsedInput,
  ProviderConfigInput,
  ResourceLoader,
  SessionManager,
  SessionPlugin,
  ToolDefinition,
} from "@zpi-dev/coding-agent";

export type UUID = string;
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";
export type ThinkingConfig =
  | { type: "disabled" }
  | { type: "adaptive" }
  | { type: "enabled"; budgetTokens?: number };
export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature: string };
export type ToolUseBlock = { type: "tool_use"; id: string; name: string; input: Record<string, unknown> };
export type ImageBlock = { type: "image"; source: { type: "base64"; media_type: string; data: string } };
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string | (TextBlock | ImageBlock)[];
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock | ImageBlock;
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  server_tool_use: { web_search_requests: number; web_fetch_requests: number };
}
export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  webSearchRequests: number;
  costUSD: number;
  contextWindow: number;
  maxOutputTokens: number;
}
export interface SDKUserMessage {
  type: "user";
  uuid?: UUID;
  session_id?: string;
  parent_tool_use_id: string | null;
  message: { role: "user"; content: string | (TextBlock | ImageBlock | ToolResultBlock)[] };
  isSynthetic?: boolean;
  tool_use_result?: unknown;
}
export interface SDKAssistantMessage {
  type: "assistant";
  uuid: UUID;
  session_id: string;
  parent_tool_use_id: string | null;
  message: {
    id: string;
    type: "message";
    role: "assistant";
    model: string;
    content: (TextBlock | ThinkingBlock | ToolUseBlock)[];
    stop_reason: "end_turn" | "tool_use" | "max_tokens" | null;
    stop_sequence: string | null;
    usage: Usage;
  };
  error?: "unknown" | "authentication_failed" | "rate_limit" | "server_error";
  aborted?: true;
}
export interface SDKSystemMessage {
  type: "system";
  subtype: "init";
  uuid: UUID;
  session_id: string;
  cwd: string;
  tools: string[];
  model: string;
  apiKeySource: "user" | "env";
  claude_code_version: string;
  mcp_servers: never[];
  slash_commands: string[];
  output_style: string;
  skills: string[];
  plugins: { name: string; path: string }[];
  agents?: string[];
  capabilities?: string[];
}
export type RawStreamEvent =
  | { type: "message_start"; message: SDKAssistantMessage["message"] }
  | { type: "content_block_start"; index: number; content_block: TextBlock | ThinkingBlock | ToolUseBlock }
  | {
      type: "content_block_delta";
      index: number;
      delta:
        | { type: "text_delta"; text: string }
        | { type: "thinking_delta"; thinking: string }
        | { type: "input_json_delta"; partial_json: string };
    }
  | { type: "content_block_stop"; index: number }
  | {
      type: "message_delta";
      delta: { stop_reason: SDKAssistantMessage["message"]["stop_reason"]; stop_sequence: null };
      usage: Usage;
    }
  | { type: "message_stop" };
export interface SDKPartialAssistantMessage {
  type: "stream_event";
  event: RawStreamEvent;
  uuid: UUID;
  session_id: string;
  parent_tool_use_id: string | null;
}
export interface SDKPermissionDenial {
  tool_name: string;
  tool_use_id: string;
  tool_input: Record<string, unknown>;
}
interface ResultBase {
  type: "result";
  uuid: UUID;
  session_id: string;
  duration_ms: number;
  duration_api_ms: number;
  num_turns: number;
  is_error: boolean;
  stop_reason: string | null;
  total_cost_usd: number;
  usage: Usage;
  modelUsage: Record<string, ModelUsage>;
  permission_denials: SDKPermissionDenial[];
}
export type SDKResultMessage = ResultBase &
  (
    | { subtype: "success"; result: string; structured_output?: unknown }
    | {
        subtype:
          | "error_max_turns"
          | "error_during_execution"
          | "error_max_budget_usd"
          | "error_max_structured_output_retries";
        errors: string[];
      }
  );
export type HookEvent =
  | "SessionStart"
  | "SessionEnd"
  | "UserPromptSubmit"
  | "PreToolUse"
  | "PostToolUse"
  | "PostToolUseFailure"
  | "Stop"
  | "SubagentStart"
  | "SubagentStop"
  | "PreCompact"
  | "PostCompact";
export interface BaseHookInput {
  session_id: string;
  transcript_path: string;
  cwd: string;
}
export interface SessionStartHookInput extends BaseHookInput {
  hook_event_name: "SessionStart";
  source: string;
}
export interface SessionEndHookInput extends BaseHookInput {
  hook_event_name: "SessionEnd";
  reason: string;
}
export interface UserPromptSubmitHookInput extends BaseHookInput {
  hook_event_name: "UserPromptSubmit";
  prompt: string;
}
export interface PreToolUseHookInput extends BaseHookInput {
  hook_event_name: "PreToolUse";
  tool_name: string;
  tool_input: Record<string, unknown>;
  tool_use_id: string;
}
export interface PostToolUseHookInput extends Omit<PreToolUseHookInput, "hook_event_name"> {
  hook_event_name: "PostToolUse";
  tool_response: unknown;
}
export interface PostToolUseFailureHookInput extends Omit<PreToolUseHookInput, "hook_event_name"> {
  hook_event_name: "PostToolUseFailure";
  error: string;
}
export interface StopHookInput extends BaseHookInput {
  hook_event_name: "Stop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
}
export interface SubagentStartHookInput extends BaseHookInput {
  hook_event_name: "SubagentStart";
  agent_id: string;
  agent_type: string;
}
export interface SubagentStopHookInput extends Omit<SubagentStartHookInput, "hook_event_name"> {
  hook_event_name: "SubagentStop";
  stop_hook_active: boolean;
  last_assistant_message?: string;
}
export interface PreCompactHookInput extends BaseHookInput {
  hook_event_name: "PreCompact";
  trigger: "manual" | "auto";
  custom_instructions: string;
}
export interface PostCompactHookInput extends Omit<PreCompactHookInput, "hook_event_name"> {
  hook_event_name: "PostCompact";
}
export type HookInput =
  | SessionStartHookInput
  | SessionEndHookInput
  | UserPromptSubmitHookInput
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | StopHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput;
export interface SyncHookJSONOutput {
  continue?: boolean;
  stopReason?: string;
  decision?: "approve" | "block";
  reason?: string;
  suppressOutput?: boolean;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: HookEvent;
    additionalContext?: string;
    updatedInput?: Record<string, unknown>;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
  };
}
export type HookJSONOutput = SyncHookJSONOutput;
export type HookCallback = (
  input: HookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<HookJSONOutput>;
export interface HookCallbackMatcher {
  matcher?: string;
  hooks: HookCallback[];
  timeout?: number;
  onFailure?: "continue" | "block";
}
export type PermissionResult =
  | { behavior: "allow"; updatedInput?: Record<string, unknown> }
  | { behavior: "deny"; message: string; interrupt?: boolean };
export type CanUseTool = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string; requestId: string; agentID?: string },
) => Promise<PermissionResult | null>;
export interface AgentDefinition {
  description: string;
  prompt: string;
  tools?: string[];
  disallowedTools?: string[];
  model?: string;
  maxTurns?: number;
  effort?: Effort;
  skills?: string[];
}
export interface SdkPluginConfig {
  type: "local";
  path: string;
}
export interface ZpiOptions {
  requestOptions?:
    | import("@zpi-dev/ai").SimpleStreamOptions
    | (() => import("@zpi-dev/ai").SimpleStreamOptions);
  modelRuntime?: ModelRuntime;
  providers?: Record<string, ProviderConfigInput>;
  fetch?: typeof fetch;
  agentDir?: string;
  plugins?: readonly SessionPlugin[];
  customTools?: readonly ToolDefinition[];
  resourceLoader?: ResourceLoader;
  /** Advanced host-owned session; preserves indexed history and native tool/plugin contracts. */
  session?: AgentSession;
  sessionManager?: SessionManager;
  input?: { parsed: ParsedInput; context: InputContext };
}
export interface Options {
  cwd?: string;
  model?: string;
  abortController?: AbortController;
  env?: Record<string, string | undefined>;
  tools?: string[] | { type: "preset"; preset: "claude_code" };
  allowedTools?: string[];
  disallowedTools?: string[];
  canUseTool?: CanUseTool;
  systemPrompt?:
    | string
    | string[]
    | { type: "custom"; prompt: string | string[] }
    | { type: "preset"; preset: "claude_code"; append?: string };
  thinking?: ThinkingConfig;
  effort?: Effort;
  maxThinkingTokens?: number;
  maxTurns?: number;
  maxBudgetUsd?: number;
  includePartialMessages?: boolean;
  forwardSubagentText?: boolean;
  includeHookEvents?: boolean;
  hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  persistSession?: boolean;
  resume?: string;
  continue?: boolean;
  forkSession?: boolean;
  resumeSessionAt?: string;
  sessionId?: string;
  title?: string;
  outputFormat?: { type: "json_schema"; schema: Record<string, unknown> };
  agents?: Record<string, AgentDefinition>;
  agent?: string;
  plugins?: SdkPluginConfig[];
  skills?: string[] | "all";
  settingSources?: ("user" | "project" | "local")[];
  enableFileCheckpointing?: boolean;
  zpi?: ZpiOptions;
}
export interface SDKHookResponseMessage {
  type: "system";
  subtype: "hook_response";
  uuid: string;
  session_id: string;
  hook_id: string;
  hook_name: string;
  hook_event: string;
  output: string;
  stdout: string;
  stderr: string;
  exit_code: number;
  outcome: "success" | "error" | "cancelled";
}
export interface SDKCompactBoundaryMessage {
  type: "system";
  subtype: "compact_boundary";
  uuid: string;
  session_id: string;
  compact_metadata: { trigger: "manual" | "auto"; pre_tokens: number };
}
export type SDKMessage =
  | SDKUserMessage
  | SDKAssistantMessage
  | SDKSystemMessage
  | SDKPartialAssistantMessage
  | SDKResultMessage
  | SDKHookResponseMessage
  | SDKCompactBoundaryMessage;
export interface SlashCommand {
  name: string;
  description: string;
  argumentHint: string;
}
export interface ModelInfo {
  value: string;
  displayName: string;
  description: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: Effort[];
}
export interface AgentInfo {
  name: string;
  description: string;
  model?: string;
}
export interface SDKControlInitializeResponse {
  commands: SlashCommand[];
  models: ModelInfo[];
  agents: AgentInfo[];
  account: { apiKeySource: string };
}
export interface RewindFilesResult {
  canRewind: boolean;
  error?: string;
  filesChanged?: string[];
  insertions?: number;
  deletions?: number;
}
export interface SDKControlInterruptResponse {
  still_queued: string[];
  cancelled?: string[];
}
export interface Query extends AsyncGenerator<SDKMessage, void> {
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  setModel(model?: string): Promise<void>;
  setMaxThinkingTokens(maxThinkingTokens: number | null): Promise<void>;
  supportedCommands(): Promise<SlashCommand[]>;
  supportedModels(): Promise<ModelInfo[]>;
  supportedAgents(): Promise<AgentInfo[]>;
  initializationResult(): Promise<SDKControlInitializeResponse>;
  rewindFiles(userMessageId: string, options?: { dryRun?: boolean }): Promise<RewindFilesResult>;
  close(): void;
}
