import type { JsonObject, Model, ReasoningConfig, ThinkingLevel } from "../types.ts";
import { compileModelOptionMap } from "./option-map/compiler.ts";
import { isJsonObject } from "./transcript.ts";

export const reasoningParameterKeys = [
  "reasoning_effort",
  "thinking",
  "reasoning",
  "enable_thinking",
  "thinking_budget",
  "reasoning_budget",
] as const;
type ReasoningModel = Pick<
  Model,
  "reasoning" | "compat" | "thinkingLevelMap" | "defaultThinkingLevel" | "reasoningConfig"
>;
export const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

// A provider may map several levels to the same request. Offer that control once,
// while keeping every mapping usable when replaying an existing task or via the SDK.
export function thinkingChoices(model: ReasoningModel): ("off" | ThinkingLevel)[] {
  if (!model.reasoning) return ["off"];
  if (model.reasoningConfig) return [...model.reasoningConfig.levels];
  const groups = new Map<string, ("off" | ThinkingLevel)[]>();
  const canonical = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
    if (isJsonObject(value))
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
        .join(",")}}`;
    return JSON.stringify(value) ?? "";
  };
  for (const level of thinkingLevels) {
    if (!canControlThinking(model, level)) continue;
    const key = canonical(reasoningParameters(model, level));
    const group = groups.get(key) ?? [];
    group.push(level);
    groups.set(key, group);
  }
  const choices = [...groups.values()].map((group) => {
    const effort = reasoningParameters(model, group[0])?.reasoning_effort;
    return (
      group.find((level) => level === "off" || level === effort) ??
      (model.defaultThinkingLevel && group.includes(model.defaultThinkingLevel)
        ? model.defaultThinkingLevel
        : undefined) ??
      (group.includes("high") ? "high" : group[0])
    );
  });
  return thinkingLevels.filter((level) => choices.includes(level));
}
export function defaultThinkingLevel(model: ReasoningModel): "off" | ThinkingLevel {
  return clampThinkingLevel(model, model.defaultThinkingLevel ?? "medium");
}
/** Pi chooses the next supported strength, then searches downwards. */
export function clampThinkingLevel(
  model: ReasoningModel,
  level: "off" | ThinkingLevel,
): "off" | ThinkingLevel {
  const choices =
    model.reasoningConfig && model.reasoning
      ? model.reasoningConfig.levels
      : thinkingLevels.filter((choice) => canControlThinking(model, choice));
  if (choices.includes(level)) return level;
  const requestedIndex = (thinkingLevels as readonly string[]).indexOf(level);
  if (requestedIndex !== -1) {
    for (let i = requestedIndex; i < thinkingLevels.length; i++)
      if (choices.includes(thinkingLevels[i])) return thinkingLevels[i];
    for (let i = requestedIndex - 1; i >= 0; i--)
      if (choices.includes(thinkingLevels[i])) return thinkingLevels[i];
  }
  return choices[0] ?? "off";
}
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
export function canControlThinking(model: ReasoningModel, level: "off" | ThinkingLevel): boolean {
  if (!model.reasoning) return level === "off";
  if (model.reasoningConfig) return model.reasoningConfig.levels.includes(level);
  if (!(thinkingLevels as readonly string[]).includes(level)) return false;
  const mapping = model.thinkingLevelMap?.[level];
  return (
    mapping !== null &&
    (isJsonObject(mapping) ||
      Boolean(model.compat?.thinkingFormat) ||
      Boolean(model.compat?.supportsReasoningEffort))
  );
}
export function reasoningParameters(
  model: ReasoningModel,
  level = model.defaultThinkingLevel ?? (model.reasoningConfig ? defaultThinkingLevel(model) : undefined),
): JsonObject | undefined {
  if (level === undefined) return undefined;
  if (!model.reasoning) return {};
  if (model.reasoningConfig) {
    if (!model.reasoningConfig.levels.includes(level))
      throw new Error(`Unsupported reasoning level: ${level}`);
    return mappedParameters(model.reasoningConfig.map, level);
  }
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

function mappedParameters(source: string, level: string): JsonObject {
  const result = compileModelOptionMap(source, "reasoningLevel").evaluate(level);
  if (Object.keys(result).some((key) => !(reasoningParameterKeys as readonly string[]).includes(key)))
    throw new Error("推理参数映射只能包含推理相关参数");
  return structuredClone(result) as JsonObject;
}

export function validateReasoningConfig(config: unknown): void {
  if (!isJsonObject(config) || Object.keys(config).some((key) => !["levels", "map"].includes(key)))
    throw new Error("无效推理配置");
  if (
    !Array.isArray(config.levels) ||
    !config.levels.length ||
    config.levels.some(
      (level) => typeof level !== "string" || !level.trim() || level !== level.trim() || level.length > 128,
    )
  )
    throw new Error("推理等级不能为空");
  if (new Set(config.levels).size !== config.levels.length) throw new Error("推理等级不能重复");
  if (typeof config.map !== "string" || !config.map.trim()) throw new Error("推理参数映射不能为空");
  for (const level of config.levels) {
    try {
      mappedParameters(config.map, level as string);
    } catch (error) {
      throw new Error(`推理等级 ${level}：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

// Seed the editor with actual provider controls, so binary thinking providers
// start with two chips and every chip already has a complete request mapping.
export function editableReasoningConfig(model: ReasoningModel): ReasoningConfig {
  if (model.reasoningConfig) return structuredClone(model.reasoningConfig);
  const supported = thinkingChoices(model);
  const choices = supported.filter((level) => level !== "minimal" || !supported.includes("low"));
  const levels = choices.map((level) => (level === "off" ? "none" : level));
  const parameters = choices.map((level) => reasoningParameters(model, level) ?? {});
  if (
    parameters.every(
      (value, index) => Object.keys(value).length === 1 && value.reasoning_effort === levels[index],
    )
  )
    return { levels, map: '{"reasoning_effort": reasoningLevel}' };
  return {
    levels,
    map: parameters
      .map((value, index) =>
        index === parameters.length - 1
          ? JSON.stringify(value, null, 2)
          : `reasoningLevel == ${JSON.stringify(levels[index])}\n  ? ${JSON.stringify(value, null, 2)}\n  : `,
      )
      .join(""),
  };
}
