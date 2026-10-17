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

export function quickChatSelectionIsValid(
  providers: readonly ProviderRecord[],
  selection: CombinedSelection,
): boolean {
  const match = quickChatModels(providers).find(
    ({ provider, model }) => provider.id === selection.provider && model.id === selection.modelId,
  );
  return Boolean(
    match && canControlThinking(reasoningModel(match.model), toThinking(selection.reasoning, match.model)),
  );
}

export function quickChatSelection(
  settings: Pick<PublicSettings, "providers" | "quickChat">,
): CombinedSelection | null {
  const models = quickChatModels(settings.providers);
  const saved = settings.quickChat.defaultSelection;
  if (saved && quickChatSelectionIsValid(settings.providers, saved)) return { ...saved };
  for (const { provider, model } of models) {
    const reasoning = defaultPreset(model);
    if (canControlThinking(reasoningModel(model), toThinking(reasoning, model)))
      return { provider: provider.id, modelId: model.id, reasoning };
  }
  return null;
}
