import { canControlThinking, providerApi } from "zpi-ai";
import type { CombinedSelection, ProviderRecord, PublicSettings } from "./bridge.ts";
import { availablePresets, defaultPreset, reasoningModel, toThinking } from "./config.ts";

/** Keep model order and reasoning choices consistent between settings and the temporary host. */
export function quickChatModels(providers: readonly ProviderRecord[]) {
  return providers
    .filter((provider) => provider.enabled !== false)
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.enabled !== false)
        .map((model) => {
          const configured = {
            ...model,
            api: providerApi(provider.preset, provider.api ?? "openai-completions"),
          };
          return { provider, model: configured, presets: availablePresets(configured) };
        })
        .filter(({ presets }) => presets.length > 0),
    );
}

type QuickChatModel = ReturnType<typeof quickChatModels>[number];

export function matchQuickChatSelection(models: readonly QuickChatModel[], selection: CombinedSelection) {
  const match = models.find(
    ({ provider, model }) => provider.id === selection.provider && model.id === selection.modelId,
  );
  return match &&
    canControlThinking(reasoningModel(match.model), toThinking(selection.reasoning, match.model))
    ? match
    : undefined;
}

export function quickChatSelectionIsValid(
  providers: readonly ProviderRecord[],
  selection: CombinedSelection,
): boolean {
  return Boolean(matchQuickChatSelection(quickChatModels(providers), selection));
}

export function quickChatSelection(
  settings: Pick<PublicSettings, "providers" | "quickChat">,
  models: readonly QuickChatModel[] = quickChatModels(settings.providers),
): CombinedSelection | null {
  const saved = settings.quickChat.defaultSelection;
  if (saved && matchQuickChatSelection(models, saved)) return { ...saved };
  for (const { provider, model } of models) {
    const reasoning = defaultPreset(model);
    if (canControlThinking(reasoningModel(model), toThinking(reasoning, model)))
      return { provider: provider.id, modelId: model.id, reasoning };
  }
  return null;
}
