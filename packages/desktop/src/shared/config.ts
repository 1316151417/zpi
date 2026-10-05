import type { ThinkingLevel } from "zpi-agent";
import { canControlThinking } from "zpi-ai";
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
export const reasoningPresets = ["disabled", "low", "high", "max"] as const;
export const reasoningLabels = { disabled: "关闭", low: "低", high: "高", max: "最高" } as const;
export const defaultPreferences: InterfacePreferences = {
  theme: "system",
  fontSize: 14,
  showContextUsage: false,
  showSendButton: false,
  sidebarCollapsed: false,
  sidebarWidth: sidebarLimits.default,
  collapsedProjectIds: [],
  projectsCollapsed: false,
  tasksCollapsed: false,
};
export function toThinking(preset: ReasoningPreset): ThinkingLevel {
  return preset === "disabled" ? "off" : preset;
}
export function toPreset(level: ThinkingLevel): ReasoningPreset {
  if (level === "off") return "disabled";
  if (level === "minimal" || level === "low") return "low";
  if (level === "medium" || level === "high") return "high";
  return "max";
}

export function availablePresets(model: ModelSettings): ReasoningPreset[] {
  return reasoningPresets.filter((p) =>
    canControlThinking(
      {
        reasoning: model.reasoning ?? modelDefaults.reasoning,
        compat: { ...modelDefaults.compat, ...model.compat },
        thinkingLevelMap: model.thinkingLevelMap,
      },
      toThinking(p),
    ),
  );
}

export function modelReasoningLabel(model: ModelSettings | undefined, preset: ReasoningPreset): string {
  if (model?.reasoning && preset === "high" && model.compat?.supportsReasoningEffort === false) return "默认";
  return reasoningLabels[preset];
}
