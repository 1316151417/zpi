import type { TSchema } from "typebox";
import type { AgentTool } from "zpi-agent";
import type { JsonValue } from "zpi-ai";
import type { ExtensionContext, ToolDefinition } from "./compat.ts";
export function wrapToolDefinition<T extends TSchema, D>(
  definition: ToolDefinition<T, D>,
  context?: () => ExtensionContext | undefined,
): AgentTool<T> {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    prepareArguments: definition.prepareArguments,
    execute: async (id, params, signal, update) => {
      const result = await definition.execute(
        id,
        params,
        signal,
        update
          ? (result) =>
              update({
                ...result,
                details:
                  result.details === undefined
                    ? undefined
                    : (JSON.parse(JSON.stringify(result.details)) as JsonValue),
              })
          : undefined,
        context?.(),
      );
      return {
        ...result,
        details:
          result.details === undefined
            ? undefined
            : (JSON.parse(JSON.stringify(result.details)) as JsonValue),
      };
    },
  };
}
