export type { ModelDiscoveryInput, ModelDiscoveryResult } from "./providers/discovery.ts";
export { fetchProviderModels } from "./providers/discovery.ts";
export type { DiscoveredModel, ProviderPresetId } from "./providers/registry.ts";
export {
  discoverProviderCredentials,
  getProviderPreset,
  presetModels,
  providerPresets,
} from "./providers/registry.ts";
export type * from "./types.ts";
export { openAICompletionsCompatKeys } from "./types.ts";
export type { ContextUsageAnchor } from "./utils/estimate.ts";
export {
  contextChars,
  estimateContextTokens,
  messageChars,
  restoreUsageAnchor,
  usageAnchor,
} from "./utils/estimate.ts";
export { AssistantMessageEventStream, createAssistantMessageEventStream } from "./utils/event-stream.ts";
export { canControlThinking, reasoningParameters, validateThinkingMap } from "./utils/reasoning.ts";
export {
  assertSupportedOptions,
  emptyAssistant,
  getCurrentSystemPrompt,
  getCurrentTools,
  isJsonObject,
  isJsonValue,
  normalizeContext,
  toToolDeclaration,
} from "./utils/transcript.ts";
