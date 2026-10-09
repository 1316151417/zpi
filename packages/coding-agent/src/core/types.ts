import type { AgentTool, AgentToolResult, AgentToolUpdateCallback } from "ZPI-agent";
import type { JsonValue, Model } from "ZPI-ai";
import type { Static, TSchema } from "typebox";
import type { LoadedSkill, SkillList } from "./resources.ts";
import type { SessionManager } from "./session-manager.ts";
export interface ResourceLoader {
  getSystemPrompt(): string | undefined;
  getAppendSystemPrompt(): string[];
  reload?(): Promise<void>;
  listSkills?(): SkillList;
  loadSkill?(name: string): Promise<LoadedSkill>;
  getDiagnostics?(): ResourceDiagnostic[];
}
export interface ResourceDiagnostic {
  path: string;
  message: string;
}
export class StaticResourceLoader implements ResourceLoader {
  private prompt?: string;
  private append: string[];
  constructor(prompt?: string, append: string[] = []) {
    this.prompt = prompt;
    this.append = [...append];
  }
  getSystemPrompt(): string | undefined {
    return this.prompt;
  }
  getAppendSystemPrompt(): string[] {
    return [...this.append];
  }
}
export interface ExtensionToolContext {
  cwd: string;
  model: Model;
  sessionManager: SessionManager;
  signal?: AbortSignal;
  isIdle(): boolean;
  getSystemPrompt(): string;
}
export interface ToolDefinition<TParameters extends TSchema = TSchema, TDetails = JsonValue | undefined>
  extends Pick<AgentTool, "executionMode" | "metadata" | "permission" | "requiresUserInteraction"> {
  name: string;
  label: string;
  description: string;
  parameters: TParameters;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute(
    toolCallId: string,
    params: Static<TParameters>,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<TDetails> | undefined,
    ctx: ExtensionToolContext,
  ): Promise<AgentToolResult<TDetails>>;
}
