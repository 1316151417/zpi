import { fastServiceTier, type Model, modelServiceTiers, providerApi } from "@zpi-dev/ai";
import type { ModelSettings, ProviderInput } from "./bridge.ts";

export function supportsFastMode(provider: Pick<ProviderInput, "preset" | "api">, model: ModelSettings) {
  return (
    fastServiceTier({
      api: providerApi(provider.preset, provider.api ?? "openai-completions"),
      serviceTiers: modelServiceTiers(provider.preset, model),
    }) !== undefined
  );
}

/** Apply only to a run's model snapshot; provider configuration stays independent of the conversation. */
export function withFastMode(model: Model, enabled?: boolean): Model {
  const tier = fastServiceTier(model);
  return tier
    ? { ...model, samplingParams: { ...model.samplingParams, service_tier: enabled ? tier : "default" } }
    : model;
}
