import { expect, it } from "vitest";
import type { ModelSettings } from "../src/shared/bridge.ts";
import { defaultPreset, mergeDiscoveredModels } from "../src/shared/config.ts";

it.each([
  { levels: ["low", "medium", "high"], expected: "medium" },
  { levels: ["medium", "high", "xhigh", "max"], expected: "medium" },
  { levels: ["中", "高", "极高"], expected: "中" },
  { levels: ["low", "high", "max"], expected: "high" },
  { levels: ["low", "high", "xhigh", "max"], expected: "high" },
  { levels: ["low", "high"], expected: "low" },
  { levels: ["high"], expected: "high" },
  { levels: ["brief", "balanced", "thorough"], expected: "balanced" },
  { levels: ["brief", "balanced", "thorough", "deep"], expected: "balanced" },
  { levels: [], expected: "none" },
])(
  "defaults to $expected for ordered choices $levels, ignoring provider defaults",
  ({ levels, expected }) => {
    const model = {
      id: "test",
      reasoning: true,
      defaultThinkingLevel: levels.at(-1),
      reasoningConfig: { levels, map: '{"reasoning_effort": reasoningLevel}' },
    };
    expect(defaultPreset(model)).toBe(expected);
  },
);

it("chooses among actual displayed strengths and keeps non-reasoning models off", () => {
  expect(
    defaultPreset({
      id: "binary",
      reasoning: true,
      compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
    }),
  ).toBe("none");
  expect(defaultPreset({ id: "plain", reasoning: false, defaultThinkingLevel: "high" })).toBe("none");
  for (const defaultThinkingLevel of ["low", "high"]) {
    expect(defaultPreset({ id: "gpt", reasoning: true, defaultThinkingLevel })).toBe("medium");
  }
});

it("refreshes recommended models in discovery order and removes missing recommended models", () => {
  const current: ModelSettings[] = [
    { id: "old", contextWindow: 1_000, useRecommendedConfig: true },
    { id: "updated", contextWindow: 1_000, useRecommendedConfig: true },
  ];
  const discovered: ModelSettings[] = [
    { id: "new", contextWindow: 8_000 },
    { id: "updated", contextWindow: 16_000 },
  ];
  expect(mergeDiscoveredModels(current, discovered)).toEqual([
    { id: "new", contextWindow: 8_000, useRecommendedConfig: true },
    { id: "updated", contextWindow: 16_000, useRecommendedConfig: true },
  ]);
});

it("keeps the user's enabled state when refreshing recommended configuration", () => {
  expect(
    mergeDiscoveredModels(
      [{ id: "model", enabled: false, useRecommendedConfig: true }],
      [{ id: "model", enabled: true, contextWindow: 16_000 }],
    ),
  ).toEqual([{ id: "model", enabled: false, contextWindow: 16_000, useRecommendedConfig: true }]);
});

it("retains manual models outside the current discovery catalog", () => {
  const custom: ModelSettings = { id: "manual", useRecommendedConfig: false, maxTokens: 8_000 };
  const merged = mergeDiscoveredModels([custom], [{ id: "discovered" }]);
  expect(merged.map((model) => model.id)).toEqual(["discovered", "manual"]);
  expect(merged[1]).toBe(custom);
});

it("preserves the original custom draft and its unsaved fields when discovery matches its ID", () => {
  const draft = {
    id: "custom",
    useRecommendedConfig: false,
    contextWindow: 8_000,
    samplingText: '{"temperature": 0.4',
    reasoningConfig: { levels: ["high"], map: '{"reasoning_effort": reasoningLevel}' },
  };
  const discovered = { ...draft, contextWindow: 16_000, samplingText: "" };
  expect(mergeDiscoveredModels([draft], [discovered])[0]).toBe(draft);
});

it("keeps disabled reasoning configuration intact when invalid mapping is rejected", async () => {
  const { draftModel, serializeModel } = await import("../src/renderer/ModelConfigDialog.tsx");
  const draft = draftModel({
    id: "custom",
    reasoning: false,
    reasoningConfig: { levels: [], map: "" },
  });
  const original = structuredClone(draft);
  expect(() => serializeModel(draft)).toThrow("推理等级不能为空");
  expect(draft).toEqual(original);
  const repaired = { ...draft, reasoningConfig: { levels: ["none"], map: "{}" } };
  expect(serializeModel(repaired)).toMatchObject({
    reasoning: false,
    reasoningConfig: repaired.reasoningConfig,
  });
});
