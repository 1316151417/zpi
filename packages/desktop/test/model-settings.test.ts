import { expect, it } from "vitest";
import type { ModelSettings } from "../src/shared/bridge.ts";
import { mergeDiscoveredModels } from "../src/shared/config.ts";

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
