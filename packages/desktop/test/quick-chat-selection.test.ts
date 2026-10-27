import { describe, expect, it, vi } from "vitest";
import type { ModelSettings, ProviderRecord } from "../src/shared/bridge.ts";
import {
  matchQuickChatSelection,
  quickChatModels,
  quickChatSelection,
  quickChatSelectionIsValid,
} from "../src/shared/quick-chat-settings.ts";

function provider(id: string, models: ModelSettings[]): ProviderRecord {
  return { id, name: id, baseUrl: "https://example.com/v1", hasApiKey: true, models };
}

describe("quick-chat model catalog", () => {
  it("keeps provider and model order while excluding disabled models and unavailable reasoning", () => {
    const providers = [
      { ...provider("disabled", [{ id: "hidden", reasoning: false }]), enabled: false },
      provider("first", [
        { id: "disabled", reasoning: false, enabled: false },
        { id: "unsupported", reasoning: true, compat: { supportsReasoningEffort: false } },
        { id: "one", reasoning: false },
        { id: "two", reasoning: false },
      ]),
      { ...provider("second", [{ id: "one", reasoning: true }]), api: "anthropic-messages" as const },
    ];
    const models = quickChatModels(providers);
    expect(models.map(({ provider, model }) => [provider.id, model.id, model.api])).toEqual([
      ["first", "one", "openai-completions"],
      ["first", "two", "openai-completions"],
      ["second", "one", "anthropic-messages"],
    ]);
    for (const selection of [
      { provider: "disabled", modelId: "hidden", reasoning: "none" },
      { provider: "first", modelId: "disabled", reasoning: "none" },
      { provider: "first", modelId: "unsupported", reasoning: "medium" },
      { provider: "first", modelId: "one", reasoning: "high" },
    ]) {
      expect(matchQuickChatSelection(models, selection)).toBeUndefined();
      expect(quickChatSelectionIsValid(providers, selection)).toBe(false);
      expect(quickChatSelection({ providers, quickChat: { defaultSelection: selection } })).toEqual({
        provider: "first",
        modelId: "one",
        reasoning: "none",
      });
    }
    expect(quickChatSelection({ providers: [], quickChat: { defaultSelection: null } })).toBeNull();
  });

  it("retains supported saved reasoning even when equivalent display choices omit it", () => {
    const providers = [
      provider("binary", [
        {
          id: "one",
          reasoning: true,
          compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
        },
      ]),
    ];
    const models = quickChatModels(providers);
    const selection = { provider: "binary", modelId: "one", reasoning: "medium" };
    expect(models[0].presets).not.toContain(selection.reasoning);
    expect(matchQuickChatSelection(models, selection)).toBe(models[0]);
    expect(quickChatSelectionIsValid(providers, selection)).toBe(true);
    const saved = quickChatSelection({ providers, quickChat: { defaultSelection: selection } });
    expect(saved).toEqual(selection);
    expect(saved).not.toBe(selection);
  });

  it("preserves saved custom reasoning names and falls back to the lower middle choice", () => {
    const providers = [
      provider("custom", [
        {
          id: "one",
          reasoning: true,
          reasoningConfig: { levels: ["none", "balanced"], map: '{"reasoning_effort": reasoningLevel}' },
          defaultThinkingLevel: "balanced",
        },
      ]),
    ];
    const models = quickChatModels(providers);
    expect(models[0].presets).toEqual(["none", "balanced"]);
    for (const reasoning of ["none", "balanced"]) {
      const selection = { provider: "custom", modelId: "one", reasoning };
      expect(matchQuickChatSelection(models, selection)).toBe(models[0]);
      expect(quickChatSelectionIsValid(providers, selection)).toBe(true);
      expect(quickChatSelection({ providers, quickChat: { defaultSelection: selection } })).toEqual(
        selection,
      );
    }
    const invalid = { provider: "custom", modelId: "one", reasoning: "high" };
    expect(matchQuickChatSelection(models, invalid)).toBeUndefined();
    expect(quickChatSelection({ providers, quickChat: { defaultSelection: invalid } })).toEqual({
      ...invalid,
      reasoning: "none",
    });
  });

  it("constructs the catalog once per selection and reuses a supplied catalog", () => {
    const configured = [{ id: "one", reasoning: false }];
    const current = provider("first", configured);
    const readModels = vi.fn(() => configured);
    Object.defineProperty(current, "models", { get: readModels });
    const selection = { provider: "first", modelId: "one", reasoning: "none" };
    const settings = { providers: [current], quickChat: { defaultSelection: selection } };
    expect(quickChatSelection(settings)).toEqual(selection);
    expect(readModels).toHaveBeenCalledOnce();
    const models = quickChatModels(settings.providers);
    readModels.mockClear();
    expect(quickChatSelection(settings, models)).toEqual(selection);
    expect(matchQuickChatSelection(models, selection)).toBe(models[0]);
    expect(readModels).not.toHaveBeenCalled();
  });
});
