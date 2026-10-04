import type { JsonObject, Model, ThinkingLevel } from "../types.ts";
import { isJsonObject } from "./transcript.ts";

export const reasoningParameterKeys = [
  "reasoning_effort",
  "thinking",
  "reasoning",
  "enable_thinking",
  "thinking_budget",
  "reasoning_budget",
] as const;
export function validateThinkingMap(map: unknown): void {
  if (!isJsonObject(map)) throw new Error("Invalid thinkingLevelMap");
  for (const [level, value] of Object.entries(map)) {
    if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level))
      throw new Error("Invalid thinking level");
    if (value === null) continue;
    if (typeof value === "string" && value.trim()) continue;
    if (
      !isJsonObject(value) ||
      !Object.keys(value).length ||
      Object.keys(value).some((key) => !(reasoningParameterKeys as readonly string[]).includes(key))
    )
      throw new Error("Thinking mapping must contain only reasoning parameters");
  }
}
export function canControlThinking(
  model: Pick<Model, "reasoning" | "compat" | "thinkingLevelMap">,
  level: "off" | ThinkingLevel,
): boolean {
  if (!model.reasoning) return level === "off";
  const mapping = model.thinkingLevelMap?.[level];
  return (
    mapping !== null &&
    (isJsonObject(mapping) ||
      Boolean(model.compat?.thinkingFormat) ||
      Boolean(model.compat?.supportsReasoningEffort))
  );
}
export function reasoningParameters(model: Model, level?: "off" | ThinkingLevel): JsonObject | undefined {
  if (level === undefined) return undefined;
  if (!model.reasoning) return {};
  if (model.thinkingLevelMap) validateThinkingMap(model.thinkingLevelMap);
  const mapping = model.thinkingLevelMap?.[level];
  if (mapping === null) throw new Error(`Unsupported reasoning level: ${level}`);
  if (isJsonObject(mapping)) return structuredClone(mapping);
  if (model.compat?.thinkingFormat) {
    const thinking: JsonObject =
      model.compat.thinkingFormat === "zai" && level !== "off"
        ? { type: "enabled", clear_thinking: false }
        : { type: level === "off" ? "disabled" : "enabled" };
    return {
      thinking,
      ...(level !== "off" && model.compat.supportsReasoningEffort
        ? { reasoning_effort: mapping ?? level }
        : {}),
    };
  }
  if (!model.compat?.supportsReasoningEffort) {
    if (level === "off" && mapping === undefined) return {};
    throw new Error(`Unsupported reasoning control: ${level}`);
  }
  return { reasoning_effort: mapping ?? (level === "off" ? "none" : level) };
}
