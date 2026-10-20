import type {
  Api,
  AssistantMessageEventStream,
  Context,
  MediaBudgetStats,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "zpi-ai";
import {
  assertSupportedOptions,
  guardModelStream,
  normalizeContext,
  projectContextForModelMediaPolicy,
  streamSimple,
  validateReasoningConfig,
  validateThinkingMap,
} from "zpi-ai";
export interface ProviderChatModelConfig extends Omit<Model, "provider" | "api" | "baseUrl"> {
  type?: "chat";
  api?: Api;
}
export interface ProviderConfigInput {
  name?: string;
  baseUrl?: string;
  api?: Api;
  apiKey?: string;
  getApiKey?: () => Promise<string>;
  headers?: Record<string, string>;
  models?: ProviderChatModelConfig[];
  streamSimple?: (
    model: Model,
    context: TranscriptContext,
    options?: SimpleStreamOptions,
  ) => AssistantMessageEventStream;
}
export interface MediaProjectionContext {
  sessionId?: string;
  provider: string;
  modelId: string;
}
export interface ModelRuntimeOptions {
  fetch?: typeof fetch;
  /** Optional local diagnostics; the SDK has no dependency on a logging backend. */
  onMediaProjection?: (stats: MediaBudgetStats, context: MediaProjectionContext) => void;
}
export class ModelRuntime {
  private providers = new Map<string, ProviderConfigInput>();
  private keys = new Map<string, string>();
  private requestFetch?: typeof fetch;
  private onMediaProjection?: ModelRuntimeOptions["onMediaProjection"];
  constructor(requestFetch?: typeof fetch, options: ModelRuntimeOptions = {}) {
    this.requestFetch = requestFetch ?? options.fetch;
    this.onMediaProjection = options.onMediaProjection;
  }
  get fetch(): typeof fetch {
    return this.requestFetch ?? globalThis.fetch;
  }
  static async create(options: ModelRuntimeOptions = {}): Promise<ModelRuntime> {
    return new ModelRuntime(options.fetch, options);
  }
  mediaProjectionObserver(model: Model, sessionId?: string): SimpleStreamOptions["onMediaProjection"] {
    const report = this.onMediaProjection;
    return report
      ? (stats) => report(stats, { sessionId, provider: model.provider, modelId: model.id })
      : undefined;
  }
  clearProviders(): void {
    this.providers.clear();
    this.keys.clear();
  }
  registerProvider(id: string, config: ProviderConfigInput): void {
    assertSupportedOptions(
      config,
      ["name", "baseUrl", "api", "apiKey", "getApiKey", "headers", "models", "streamSimple"],
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
          "auth",
          "input",
          "cost",
          "reasoning",
          "contextWindow",
          "maxTokens",
          "headers",
          "compat",
          "thinkingLevelMap",
          "reasoningConfig",
          "defaultThinkingLevel",
          "samplingParams",
        ],
        "model",
      );
      if (model.type && model.type !== "chat") throw new Error("Only chat models are supported");
      if (model.thinkingLevelMap) validateThinkingMap(model.thinkingLevelMap);
      if (model.reasoningConfig) validateReasoningConfig(model.reasoningConfig);
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
      if (p.streamSimple || p.getApiKey || this.keys.has(id))
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
      onMediaProjection:
        options?.onMediaProjection ?? this.mediaProjectionObserver(model, options?.sessionId),
    };
    const customStream = p.streamSimple;
    if (customStream)
      return guardModelStream(
        model,
        async (guarded) => {
          const apiKey = p.getApiKey && options?.apiKey === undefined ? await p.getApiKey() : guarded.apiKey;
          guarded.signal?.throwIfAborted();
          return customStream(
            model,
            projectContextForModelMediaPolicy(transcript, model, { onProjection: opts.onMediaProjection }),
            { ...guarded, apiKey },
          );
        },
        opts,
      );
    // Native protocols own their request boundary, including direct API callers.
    // Only custom providers need projection here; the common stream wrapper does not repeat it.
    return streamSimple(model, transcript, {
      ...opts,
      ...(p.getApiKey && options?.apiKey === undefined ? { getApiKey: p.getApiKey } : {}),
    });
  }
}
