import type { Static, TSchema } from "typebox";
import type { AgentTool, AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "zpi-agent";
import type { JsonValue, Model } from "zpi-ai";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionManager } from "./session-manager.ts";
import type { ImageResizeOptions } from "./tools/pi/utils/image-resize-core.ts";
/** Resource discovery is separate from explicit customInstructions. */
export interface ResourceLoader {
  getBaseInstructions?(): string | undefined;
  getInstructions?(): readonly string[];
  /** @deprecated Use getBaseInstructions; this replaces only the template preamble. */
  getSystemPrompt?(): string | undefined;
  /** @deprecated Use getInstructions for resources, or customInstructions for session additions. */
  getAppendSystemPrompt?(): string[];
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
  return loader?.getInstructions?.() ?? loader?.getAppendSystemPrompt?.() ?? [];
}
export function resourceBaseInstructions(loader?: ResourceLoader): string | undefined {
  return loader?.getBaseInstructions ? loader.getBaseInstructions() : loader?.getSystemPrompt?.();
}
export class StaticResourceLoader implements ResourceLoader {
  private baseInstructions?: string;
  private instructions: readonly string[];
  constructor(options?: { baseInstructions?: string; instructions?: readonly string[] });
  /** @deprecated Use the named baseInstructions and instructions options. */
  constructor(baseInstructions?: string, instructions?: string[]);
  constructor(
    options?: string | { baseInstructions?: string; instructions?: readonly string[] },
    instructions: string[] = [],
  ) {
    this.baseInstructions = typeof options === "object" ? options.baseInstructions : options;
    this.instructions = [...(typeof options === "object" ? (options.instructions ?? []) : instructions)];
  }
  getBaseInstructions(): string | undefined {
    return this.baseInstructions;
  }
  getInstructions(): string[] {
    return [...this.instructions];
  }
  /** @deprecated Use getBaseInstructions. */
  getSystemPrompt(): string | undefined {
    return this.getBaseInstructions();
  }
  /** @deprecated Use getInstructions. */
  getAppendSystemPrompt(): string[] {
    return this.getInstructions();
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
/** @deprecated Use ToolContext. */
export type ExtensionToolContext = ToolContext;
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
