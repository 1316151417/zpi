import type { ToolDefinition } from "@zpi-dev/coding-agent";
import type { Static, TSchema } from "typebox";

export type DefineToolOptions<TParameters extends TSchema> = Omit<
  ToolDefinition<TParameters>,
  "label" | "execute"
> & {
  label?: string;
  /** Return text or a JSON-serializable object. Errors propagate to the native tool runner. */
  execute(
    params: Static<TParameters>,
    context: { signal: AbortSignal | undefined; toolCallId: string },
  ): string | object | Promise<string | object>;
};

/** Adapt a simple callback to the existing native tool contract. */
export function defineTool<TParameters extends TSchema>(
  options: DefineToolOptions<TParameters>,
): ToolDefinition<TParameters> {
  const { execute, label = options.name, ...definition } = options;
  return {
    ...definition,
    label,
    async execute(toolCallId, params, signal) {
      const result = await execute(params, { signal, toolCallId });
      return {
        content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result) }],
        details: undefined,
      };
    },
  };
}
