import { homedir } from "node:os";
import { resolve } from "node:path";
import { discoverProviderCredentials, type Model, presetModels, providerApi, providerBaseUrl } from "zpi-ai";
import { ModelRuntime } from "zpi-coding-agent";
import type { Options } from "./types.ts";

export async function runtimeFor(options: Options): Promise<ModelRuntime> {
  if (options.zpi?.modelRuntime) return options.zpi.modelRuntime;
  const runtime = await ModelRuntime.create({ fetch: options.zpi?.fetch });
  const env = options.env ?? process.env;
  for (const { preset, apiKey } of discoverProviderCredentials(env)) {
    const api = providerApi(preset);
    runtime.registerProvider(preset, {
      apiKey,
      api,
      baseUrl: providerBaseUrl(preset, api),
      models: presetModels(preset, api).map(
        ({ availability: _availability, metadataSource: _metadataSource, ...model }) => ({
          ...model,
          name: model.name ?? model.id,
          input: (model.input ?? ["text"]).filter(
            (kind): kind is "text" | "image" => kind === "text" || kind === "image",
          ),
          reasoning: model.reasoning ?? false,
          contextWindow: model.contextWindow ?? 128000,
          maxTokens: model.maxTokens ?? 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }),
      ),
    });
  }
  if (env.ANTHROPIC_API_KEY) {
    const id = (options.model ?? env.ANTHROPIC_MODEL)?.replace(/^anthropic\//, "");
    if (!id) throw new Error("Set options.model or ANTHROPIC_MODEL for the Anthropic provider");
    runtime.registerProvider("anthropic", {
      apiKey: env.ANTHROPIC_API_KEY,
      api: "anthropic-messages",
      baseUrl: env.ANTHROPIC_BASE_URL ?? "https://api.anthropic.com",
      models: [
        {
          id,
          name: id,
          input: ["text", "image"],
          reasoning: true,
          contextWindow: 200000,
          maxTokens: 32000,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        },
      ],
    });
  }
  for (const [id, config] of Object.entries(options.zpi?.providers ?? {}))
    runtime.registerProvider(id, config);
  return runtime;
}
export async function selectModel(runtime: ModelRuntime, name?: string): Promise<Model> {
  const models = await runtime.getAvailable();
  const qualified = name ? models.filter((model) => `${model.provider}/${model.id}` === name) : [];
  const provider = name ? models.filter((model) => model.provider === name) : [];
  const matches = qualified.length
    ? qualified
    : provider.length
      ? provider
      : name
        ? models.filter((model) => model.id === name)
        : models;
  if (!matches.length)
    throw new Error(
      name
        ? `Model is not configured: ${name}`
        : "No model configured. Set a provider API key or options.zpi.providers.",
    );
  if (name && !provider.length && matches.length > 1)
    throw new Error(`Ambiguous model: ${name}; use provider/model`);
  return matches[0];
}
export function thinkingLevel(options: Options): "off" | "low" | "medium" | "high" | "xhigh" | "max" {
  if (options.thinking?.type === "disabled" || options.maxThinkingTokens === 0) return "off";
  return options.effort ?? "medium";
}
export const sdkHome = (options: Options) => resolve(options.env?.HOME ?? homedir());
