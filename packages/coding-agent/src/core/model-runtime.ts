import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "zpi-ai";
import { assertSupportedOptions, normalizeContext, validateThinkingMap } from "zpi-ai";
import { streamSimple as openaiStream } from "zpi-ai/api/openai-completions";
export interface ProviderChatModelConfig extends Omit<Model, "provider" | "api" | "baseUrl"> {
  type?: "chat";
  api?: Api;
}
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  api?: Api;
  apiKey?: string;
  headers?: Record<string, string>;
  models?: ProviderChatModelConfig[];
  streamSimple?: (
    model: Model,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}
export class ModelRuntime {
  private providers = new Map<string, ProviderConfigInput>();
  private keys = new Map<string, string>();
  private requestFetch?: typeof fetch;
  constructor(requestFetch?: typeof fetch) {
    this.requestFetch = requestFetch;
  }
  static async create(options: { fetch?: typeof fetch } = {}): Promise<ModelRuntime> {
    return new ModelRuntime(options.fetch);
  }
  clearProviders(): void {
    this.providers.clear();
    this.keys.clear();
  }
  registerProvider(id: string, config: ProviderConfigInput): void {
    assertSupportedOptions(
      config,
      ["name", "baseUrl", "api", "apiKey", "headers", "models", "streamSimple"],
      "provider",
    );
    for (const model of config.models ?? []) {
      assertSupportedOptions(
        model,
        [
          "type",
          "id",
          "name",
          "api",
          "input",
          "cost",
          "reasoning",
          "contextWindow",
          "maxTokens",
          "headers",
          "compat",
          "thinkingLevelMap",
          "samplingParams",
        ],
        "model",
      );
      if (model.type && model.type !== "chat") throw new Error("Only chat models are supported");
      if (model.thinkingLevelMap) validateThinkingMap(model.thinkingLevelMap);
    }
    const old = this.providers.get(id);
    this.providers.set(id, { ...old, ...config, headers: config.headers ?? old?.headers });
    if (config.apiKey !== undefined) this.keys.set(id, config.apiKey);
  }
  getModel(provider: string, id: string): Model | undefined {
    const p = this.providers.get(provider);
    const model = p?.models?.find((m) => m.id === id);
    if (!p || !model) return undefined;
    const { type: _, ...fields } = model;
    return {
      ...fields,
      api: model.api ?? p.api ?? "openai-completions",
      provider,
      baseUrl: p.baseUrl ?? "",
      headers: { ...p.headers, ...model.headers },
    };
  }
  async getAvailable(): Promise<readonly Model[]> {
    const models: Model[] = [];
    for (const [id, p] of this.providers)
      if (p.streamSimple || this.keys.has(id))
        for (const m of p.models ?? []) {
          const model = this.getModel(id, m.id);
          if (model) models.push(model);
        }
    return models;
  }
  async setRuntimeApiKey(provider: string, key: string): Promise<void> {
    this.keys.set(provider, key);
  }
  streamSimple(model: Model, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
    const p = this.providers.get(model.provider);
    if (!p) throw new Error(`Provider not configured: ${model.provider}`);
    const transcript = normalizeContext(context);
    const opts = {
      ...options,
      fetch: options?.fetch ?? this.requestFetch,
      apiKey: options?.apiKey ?? this.keys.get(model.provider),
    };
    if (p.streamSimple) return p.streamSimple(model, transcript, opts);
    return openaiStream(model, transcript, opts);
  }
}
