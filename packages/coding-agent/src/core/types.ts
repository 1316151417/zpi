import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "@zpi-dev/agent";
import type { JsonValue, Model } from "@zpi-dev/ai";
import type { Static, TSchema } from "typebox";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionManager } from "./session-manager.ts";
import type { ImageResizeOptions } from "./tools/pi/utils/image-resize-core.ts";
/** Resource discovery is separate from explicit customInstructions. */
export interface ResourceLoader {
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
