import type { ThinkingLevel } from "@zpi-dev/agent";
import type { Model } from "@zpi-dev/ai";
export function toThinking(
  preset: string,
  model?: { reasoning?: boolean; reasoningConfig?: Model["reasoningConfig"] },
): ThinkingLevel {
  if (model?.reasoningConfig && model.reasoning !== false) return preset;
  return preset === "none" ? "off" : preset;
}
