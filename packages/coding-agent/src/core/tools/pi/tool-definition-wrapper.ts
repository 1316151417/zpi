import type { TSchema } from "typebox";
import type { AgentTool } from "zpi-agent";
import { assertSupportedOptions, type JsonValue } from "zpi-ai";
import type { ToolDefinition } from "../../types.ts";
export function wrapToolDefinition<T extends TSchema, D, C>(
  definition: ToolDefinition<T, D, C>,
  context: (signal?: AbortSignal) => C,
  serializeDetails = true,
): AgentTool<T> {
  assertSupportedOptions(
    definition,
    [
      "name",
      "label",
      "description",
      "parameters",
      "promptSnippet",
      "promptGuidelines",
      "prepareArguments",
      "executionMode",
      "metadata",
      "permission",
      "requiresUserInteraction",
      "outputSchema",
      "execute",
    ],
    "custom tool",
  );
  // Standalone Pi tools historically normalize details; SDK custom tools retain
  // their values for the executor's JSON validation rather than silently coercing them.
  const details = (value: D) =>
    value === undefined
      ? undefined
      : serializeDetails
        ? (JSON.parse(JSON.stringify(value)) as JsonValue)
        : (value as JsonValue);
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    parameters: definition.parameters,
    promptSnippet: definition.promptSnippet,
    promptGuidelines: definition.promptGuidelines,
    prepareArguments: definition.prepareArguments,
    executionMode: definition.executionMode,
    metadata: definition.metadata,
    permission: definition.permission,
    requiresUserInteraction: definition.requiresUserInteraction,
    execute: async (id, params, signal, update) => {
      const result = await definition.execute(
        id,
        params,
        signal,
        update
          ? (result) =>
              update({
                ...result,
                details: details(result.details),
              })
          : undefined,
        context(signal),
      );
      return {
        ...result,
        details: details(result.details),
      };
    },
  };
}
