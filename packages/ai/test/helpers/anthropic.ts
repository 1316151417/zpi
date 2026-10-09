import type { Model } from "../../src/types.ts";

export { normalizeContext } from "../../src/utils/transcript.ts";

/** Explicit transport fixtures; no provider registry or credentials required. */
export function getModel(provider = "anthropic", id = "claude-opus-4-8"): Model<"anthropic-messages"> {
  return {
    id,
    provider,
    name: id,
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
    reasoning: true,
    input: ["text"],
    contextWindow: 200000,
    maxTokens: 32000,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    compat: {
      forceAdaptiveThinking: true,
      ...(id === "claude-fable-5-1" ? { supportsMidConvoEffort: true } : {}),
    },
  };
}
