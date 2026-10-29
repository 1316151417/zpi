import type { ProviderConfigInput } from "zpi-coding-agent";
import { resolveModel, type SettingsStore } from "./storage.ts";

export function modelRuntimeConfig(
  config: ReturnType<SettingsStore["snapshot"]>,
  getApiKey: NonNullable<ProviderConfigInput["getApiKey"]>,
): ProviderConfigInput {
  return {
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    ...(config.preset === "openai-chatgpt" ? { getApiKey } : {}),
    models: config.models
      .filter((m) => m.enabled !== false)
      .map((m) => {
        const { provider: _provider, baseUrl: _url, ...model } = resolveModel(config, m);
        return model;
      }),
  };
}
