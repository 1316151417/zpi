import type { ThinkingLevel } from "ZPI-agent";
import { defaultThinkingLevel, thinkingChoices } from "ZPI-ai";
import type { InterfacePreferences, ModelSettings, ReasoningPreset } from "./bridge.ts";
export const modelDefaults = {
  contextWindow: 1000000,
  maxTokens: 128000,
  reasoning: true,
  compat: { supportsReasoningEffort: true },
} as const;
export const sidebarLimits = {
  default: 260,
  min: 200,
  max: 420,
  collapsed: 0,
  chatMin: 400,
  resizer: 4,
} as const;
export const uiFontSizeLimits = { min: 12, max: 20 } as const;
export const taskPinLimit = 5;
export function mergeDiscoveredModels<T extends ModelSettings>(
  current: readonly T[],
  discovered: readonly T[],
): T[] {
  const previous = new Map(current.map((model) => [model.id, model]));
  const discoveredIds = new Set(discovered.map((model) => model.id));
  return [
    ...discovered.map((model) => {
      const old = previous.get(model.id);
      return old?.useRecommendedConfig === false
        ? old
        : {
            ...model,
            useRecommendedConfig: true,
            ...(old?.enabled !== undefined ? { enabled: old.enabled } : {}),
          };
    }),
    ...current.filter(
      (model) => model.id && model.useRecommendedConfig === false && !discoveredIds.has(model.id),
    ),
  ];
}
export const reasoningPresets = ["none", "low", "medium", "high", "xhigh", "max"] as const;
export const reasoningLabels: Record<string, string> = {
  none: "关闭",
  off: "关闭",
  disabled: "关闭",
  minimal: "低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "极高",
  max: "最高",
} as const;
export const defaultPreferences: InterfacePreferences = {
  theme: "system",
  fontSize: 14,
  showContextUsage: false,
  showSendButton: false,
  notificationEnabled: true,
  notificationSoundEnabled: true,
  sidebarCollapsed: false,
  sidebarWidth: sidebarLimits.default,
  collapsedProjectIds: [],
  projectsCollapsed: false,
  tasksCollapsed: false,
};
export function toThinking(preset: ReasoningPreset, model?: ModelSettings): ThinkingLevel {
  if (model?.reasoningConfig && model.reasoning !== false) return preset;
  return preset === "none" ? "off" : preset;
}
export function toPreset(level: ThinkingLevel, model?: ModelSettings): ReasoningPreset {
  if (model?.reasoningConfig && model.reasoning !== false && model.reasoningConfig.levels.includes(level))
    return level;
  if (level === "off") return "none";
  if (level === "minimal") return "low";
  return level;
}

export function availablePresets(model: ModelSettings): ReasoningPreset[] {
  const choices = thinkingChoices(reasoningModel(model));
  if (model.reasoningConfig) return choices.map((level) => toPreset(level, model));
  return reasoningPresets.filter((preset) => choices.includes(toThinking(preset)));
}
export function reasoningModel(model: ModelSettings) {
  return {
    reasoning: model.reasoning ?? modelDefaults.reasoning,
    compat: { ...modelDefaults.compat, ...model.compat },
    thinkingLevelMap: model.thinkingLevelMap,
    defaultThinkingLevel: model.defaultThinkingLevel,
    reasoningConfig: model.reasoningConfig,
  };
}
export function defaultPreset(model: ModelSettings): ReasoningPreset {
  return toPreset(defaultThinkingLevel(reasoningModel(model)), model);
}

export function modelReasoningLabel(model: ModelSettings | undefined, preset: ReasoningPreset): string {
  if (
    !model?.reasoningConfig &&
    model?.reasoning &&
    preset === "high" &&
    model.compat?.supportsReasoningEffort === false
  )
    return "默认";
  return reasoningLabels[preset] ?? preset;
}
