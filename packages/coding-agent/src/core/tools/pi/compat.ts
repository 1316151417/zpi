import type { Static, TSchema } from "typebox";
import type { AgentToolResult, AgentToolUpdateCallback, ThinkingLevel } from "zpi-agent";
import type { Model } from "zpi-ai";
import type { SessionManager } from "../../session-manager.ts";
import type { ImageResizeOptions } from "./utils/image-resize-core.ts";
export interface ExtensionContext {
  cwd: string;
  model?: Model & { inputLimits?: { images?: { resize?: ImageResizeOptions } } };
  thinkingLevel?: ThinkingLevel;
  sessionManager: SessionManager;
}
export interface ToolDefinition<T extends TSchema, D = unknown> {
  name: string;
  label: string;
  description: string;
  parameters: T;
  promptSnippet?: string;
  promptGuidelines?: string[];
  prepareArguments?: (args: unknown) => Static<T>;
  outputSchema?: TSchema;
  execute(
    id: string,
    params: Static<T>,
    signal?: AbortSignal,
    update?: AgentToolUpdateCallback<D>,
    ctx?: ExtensionContext,
  ): Promise<AgentToolResult<D>>;
}
