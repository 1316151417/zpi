import {
  type DiscoveredModel,
  fetchProviderModels,
  getProviderPreset,
  type ProviderApi,
  providerApi,
  providerApis,
  providerBaseUrl,
} from "@zpi-dev/ai";
import type { ProviderChatModelConfig } from "@zpi-dev/coding-agent";
import type { LoginInteraction } from "./index.ts";
import type { Service } from "./store.ts";

export function validAlias(value: string) {
  return /^[a-z][a-z0-9-]{0,47}$/.test(value) && !Object.hasOwn(Object.prototype, value);
}
export function validName(value: string) {
  return /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,63}$/u.test(value);
}
export function validModelId(value: string) {
  return value.length > 0 && value.length <= 200 && !/[\p{C}\s]/u.test(value);
}
export function customAlias(name: string) {
  return validAlias(name) && !["openai", "anthropic", "custom"].includes(name) && !getProviderPreset(name);
}
export function cleanBaseUrl(address: string) {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new Error("请输入完整的 http 或 https 服务地址。");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("服务地址仅支持 http 或 https，不可含凭据、查询或片段。");
  return url.href.replace(/\/$/, "");
}
export function serviceFor(
  provider: string,
  method: "oauth" | "key",
  custom?: { api: ProviderApi; baseUrl: string },
): Service {
  if (method === "oauth" && provider !== "openai") throw new Error("仅 openai 支持 ChatGPT 订阅登录。");
  if (provider === "anthropic")
    return { provider, api: "anthropic-messages", baseUrl: "https://api.anthropic.com" };
  const preset = getProviderPreset(
    provider === "openai" ? (method === "oauth" ? "openai-chatgpt" : "openai-api") : provider,
  );
  if (preset) {
    if (provider !== "openai" && preset.family === "openai")
      throw new Error("请使用 openai 并选择 --method oauth 或 key。");
    const api = providerApi(preset.id);
    return { provider, preset: preset.id, api, baseUrl: providerBaseUrl(preset.id, api) };
  }
  if (!custom || !customAlias(provider) || !providerApis().includes(custom.api))
    throw new Error("请输入有效的自定义服务名、协议和地址。");
  return { provider, api: custom.api, baseUrl: cleanBaseUrl(custom.baseUrl) };
}
export function runtimeModel(model: DiscoveredModel, oauth: boolean): ProviderChatModelConfig {
  return {
    id: model.id,
    name: model.name ?? model.id,
    ...(oauth ? { auth: "chatgpt" as const } : {}),
    input: (model.input ?? ["text"]).filter((kind) => kind === "text" || kind === "image"),
    reasoning: model.reasoning ?? false,
    contextWindow: model.contextWindow ?? 32768,
    maxTokens: model.maxTokens ?? 4096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: model.compat,
    thinkingLevelMap: model.thinkingLevelMap,
    defaultThinkingLevel: model.defaultThinkingLevel,
    samplingParams: model.samplingParams,
    serviceTiers: model.serviceTiers,
  };
}

export async function chooseEnabledModels(
  service: Service,
  key: string,
  previous: DiscoveredModel[],
  reuse: boolean,
  ui: LoginInteraction,
  fetcher: typeof fetch,
) {
  const oauth = service.preset === "openai-chatgpt";
  let status: number | undefined;
  const observe: typeof fetch = async (url, options) => {
    const signals = [options?.signal, ui.signal].filter((s): s is AbortSignal => Boolean(s));
    const response = await fetcher(url, { ...options, signal: AbortSignal.any(signals) });
    status = response.status;
    return response;
  };
  let candidates: DiscoveredModel[] = [];
  let manual = false;
  try {
    const result = await fetchProviderModels({ ...service, apiKey: key }, observe);
    if (result.source === "catalog" && ![404, 405, 501].includes(status ?? 0))
      throw new Error("服务目录验证失败");
    candidates = result.models.filter(
      (m) => validModelId(m.id) && (!oauth || (result.source === "remote" && m.availability === "listed")),
    );
    if (result.source === "catalog" && result.warning) ui.warn(result.warning);
  } catch {
    ui.signal?.throwIfAborted();
    if (reuse && previous.length)
      throw new Error("订阅模型发现失败，已保留原连接。请稍后重试，或选择在浏览器中重新授权。");
    if (status === 401 || status === 403) {
      if (!oauth || reuse) throw new Error("服务拒绝了该凭据，请检查账户或重新登录。");
    }
    if (oauth)
      ui.warn(
        "ChatGPT 已登录，暂时无法获取订阅模型。请用 zpi auth login openai --method oauth 选择此账户重试模型发现。",
      );
    else if (customAlias(service.provider) && status !== undefined && [200, 404, 405, 501].includes(status))
      manual = true;
    else throw new Error("模型发现失败。请检查服务地址、凭据和网络。");
  }
  if (!oauth && !manual && !candidates.length) throw new Error("此连接没有可启用的模型。");
  const picked = candidates.length || manual ? await ui.chooseModels(candidates, previous, manual) : [];
  let models: DiscoveredModel[];
  if (manual) {
    models = picked.map((m) => {
      if (
        !validModelId(m.id) ||
        !Number.isSafeInteger(m.contextWindow) ||
        !Number.isSafeInteger(m.maxTokens) ||
        !m.contextWindow ||
        !m.maxTokens ||
        m.maxTokens < 1 ||
        m.maxTokens > m.contextWindow
      )
        throw new Error("请提供有效的模型 ID、上下文和输出上限。");
      return {
        id: m.id,
        contextWindow: m.contextWindow,
        maxTokens: m.maxTokens,
        input: ["text"],
        reasoning: false,
      };
    });
  } else {
    models = picked.map((m) => {
      const found = candidates.find((c) => c.id === m.id);
      if (!found) throw new Error("无法启用服务目录之外的模型。");
      return found;
    });
  }
  if (
    new Set(models.map((m) => m.id)).size !== models.length ||
    ((manual || candidates.length) && !models.length)
  )
    throw new Error("至少启用一个模型，ID 不可重复。");
  return models;
}
