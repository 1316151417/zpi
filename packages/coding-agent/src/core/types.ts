import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@zpi-dev/agent";
import type { JsonValue, Model } from "@zpi-dev/ai";
import type { Static, TSchema } from "typebox";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionManager } from "./session-manager.ts";
import type { ImageResizeOptions } from "./tools/pi/utils/image-resize-core.ts";
/** Resource discovery is separate from explicit customInstructions. */
export interface ResourceLoader {
  /** Stable catalog and injected instructions; allows caching prompt sections. Skill files may still be read live. */
  readonly immutable?: boolean;
  getBaseInstructions?(): string | undefined;
  getInstructions?(): readonly string[];
  reload?(): Promise<void>;
  listSkills?(): SkillList;
  loadSkill?(name: string): Promise<LoadedSkill>;
  getDiagnostics?(): ResourceDiagnostic[];
}
export interface ResourceDiagnostic {
  path: string;
  message: string;
}
export function resourceInstructions(loader?: ResourceLoader): readonly string[] {
  return loader?.getInstructions?.() ?? [];
}
export function resourceBaseInstructions(loader?: ResourceLoader): string | undefined {
  return loader?.getBaseInstructions?.();
}
export class StaticResourceLoader implements ResourceLoader {
  private baseInstructions?: string;
  private instructions: readonly string[];
  constructor(options: { baseInstructions?: string; instructions?: readonly string[] } = {}) {
    this.baseInstructions = options.baseInstructions;
    this.instructions = [...(options.instructions ?? [])];
  }
  getBaseInstructions(): string | undefined {
    return this.baseInstructions;
  }
  getInstructions(): string[] {
    return [...this.instructions];
  }
}
/** Session context supplied to custom tools and built-in overrides. */
export interface ToolContext {
  cwd: string;
  model: Model & { inputLimits?: { images?: { resize?: ImageResizeOptions } } };
  sessionManager: SessionManager;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  isIdle(): boolean;
  getSystemPrompt(): string;
  getToolNames?(): string[];
}
export interface ToolDefinition<
  TParameters extends TSchema = TSchema,
  TDetails = JsonValue | undefined,
  TContext = ToolContext,
> extends Pick<AgentTool, "executionMode" | "metadata" | "permission" | "requiresUserInteraction"> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  promptSnippet?: string;
  promptGuidelines?: string[];
  /** Optional result schema metadata; tool results retain their existing runtime validation. */
  outputSchema?: TSchema;
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    context: TContext,
  ): Promise<AgentToolResult<TDetails>>;
}

/** Usage snapshot attached to host background-task events. */
export type TaskUsage = { total_tokens: number; tool_uses: number; duration_ms: number };
interface TaskMessageBase {
  /** Identifies one run when a host backend can resume the same task ID. */
  run_id?: string;
  type: "system";
  task_id: string;
  tool_use_id?: string;
  uuid: string;
  session_id: string;
}
export interface SDKTaskStartedMessage extends TaskMessageBase {
  subtype: "task_started";
  description: string;
  task_type?: string;
  subagent_type?: string;
  is_backgrounded?: boolean;
}
export interface SDKTaskProgressMessage extends TaskMessageBase {
  subtype: "task_progress";
  description: string;
  usage: TaskUsage;
  last_tool_name?: string;
  summary?: string;
}
export interface SDKTaskNotificationMessage extends TaskMessageBase {
  subtype: "task_notification";
  status: "completed" | "failed" | "stopped";
  output_file: string;
  summary: string;
  usage?: TaskUsage;
}
/** Stable host port event contract; the public agent SDK re-exports these names unchanged. */
export type SDKTaskMessage = SDKTaskStartedMessage | SDKTaskProgressMessage | SDKTaskNotificationMessage;
/** Host adapter owns isolation, execution and task state; consumers only project its events. */
export interface HostTaskControl {
  stopTask(sessionId: string, taskId: string, signal: AbortSignal): Promise<void>;
  subscribe?(sessionId: string, listener: (message: SDKTaskMessage) => void): () => void;
}
