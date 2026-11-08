import { providerApi } from "@zpi-dev/ai";
import type { ProviderRecord } from "./bridge.ts";
import { availablePresets } from "./config.ts";

/** Keep model order and reasoning choices consistent between model selection controls. */
export function selectableModels(providers: readonly ProviderRecord[]) {
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
