import type { Model, ModelCompat, ProviderApi } from "../types.ts";
import catalog from "./catalog.json" with { type: "json" };

export interface DiscoveredModel {
  id: string;
  name?: string;
  input?: ("text" | "image" | "video" | "pdf")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  compat?: ModelCompat;
  thinkingLevelMap?: Model["thinkingLevelMap"];
  defaultThinkingLevel?: Model["defaultThinkingLevel"];
  availability?: "listed" | "unverified";
  samplingParams?: Model["samplingParams"];
  metadataSource?: "remote" | "catalog" | "defaults";
}
export const providerPresets = [
  {
    id: "openai-chatgpt",
    name: "OpenAI（ChatGPT）",
    family: "openai",
    baseUrl: "https://api.openai.com/v1",
    envKeys: [],
    catalog: "openai-chatgpt",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    family: "deepseek",
    baseUrl: "https://api.deepseek.com",
    envKeys: ["DEEPSEEK_API_KEY"],
    catalog: "deepseek",
  },
  {
    id: "zhipu-coding",
    name: "智谱（Coding Plan）",
    family: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
    envKeys: ["ZHIPU_API_KEY", "ZHIPU_CODING_API_KEY", "ZAI_CODING_CN_API_KEY"],
    catalog: "zai-coding-cn",
  },
  {
    id: "zhipu-api",
    name: "智谱（API）",
    family: "zhipu",
    baseUrl: "https://open.bigmodel.cn/api/paas/v4",
    envKeys: ["ZHIPU_PAYGO_API_KEY", "ZHIPU_STANDARD_API_KEY"],
    catalog: "zai",
  },
  {
    id: "minimax-coding",
    name: "MiniMax（Coding Plan）",
    family: "minimax",
    baseUrl: "https://api.minimax.cn/v1",
    envKeys: ["MINIMAX_API_KEY"],
    catalog: "minimax-cn",
  },
  {
    id: "minimax-api",
    name: "MiniMax（API）",
    family: "minimax",
    baseUrl: "https://api.minimax.cn/v1",
    envKeys: ["MINIMAX_PAYGO_API_KEY"],
    catalog: "minimax-cn",
  },
  {
    id: "mimo-coding",
    name: "MiMo（Token Plan）",
    family: "mimo",
    baseUrl: "https://token-plan-cn.xiaomimimo.com/v1",
    envKeys: ["MIMO_API_KEY", "XIAOMI_TOKEN_PLAN_CN_API_KEY"],
    catalog: "xiaomi-token-plan-cn",
  },
  {
    id: "mimo-api",
    name: "MiMo（API）",
    family: "mimo",
    baseUrl: "https://api.xiaomimimo.com/v1",
    envKeys: ["MIMO_PAYGO_API_KEY", "XIAOMI_API_KEY"],
    catalog: "xiaomi",
  },
] as const;
export type ProviderPresetId = (typeof providerPresets)[number]["id"];
export function getProviderPreset(id: string) {
  return providerPresets.find((preset) => preset.id === id);
}
export function presetModels(id: string, api: ProviderApi = "openai-completions"): DiscoveredModel[] {
  const preset = getProviderPreset(id);
  const models = preset?.catalog ? (structuredClone(catalog[preset.catalog]) as DiscoveredModel[]) : [];
  if (api !== "anthropic-messages") return models;
  return models.map((model) => {
    const compat: ModelCompat = {
      supportsEagerToolInputStreaming: false,
      supportsLongCacheRetention: false,
      allowEmptySignature: true,
      ...(preset?.family === "deepseek" ||
      preset?.family === "minimax" ||
      model.compat?.supportsReasoningEffort
        ? { forceAdaptiveThinking: true }
        : {}),
    };
    const result = { ...model, compat };
    delete result.samplingParams;
    return result;
  });
}
export function usesChatGPTAuth(preset?: string): boolean {
  return preset === "openai-chatgpt";
}
const anthropicBaseUrls: Record<string, string> = {
  deepseek: "https://api.deepseek.com/anthropic",
  "zhipu-coding": "https://open.bigmodel.cn/api/anthropic",
  "zhipu-api": "https://open.bigmodel.cn/api/anthropic",
  "minimax-coding": "https://api.minimax.cn/anthropic",
  "minimax-api": "https://api.minimax.cn/anthropic",
  "mimo-coding": "https://token-plan-cn.xiaomimimo.com/anthropic",
  "mimo-api": "https://api.xiaomimimo.com/anthropic",
};
export function providerApis(preset?: string): readonly ProviderApi[] {
  return usesChatGPTAuth(preset)
    ? ["openai-responses"]
    : preset
      ? ["anthropic-messages", "openai-completions"]
      : ["anthropic-messages", "openai-completions", "openai-responses"];
}
export function providerApi(preset?: string, api?: ProviderApi): ProviderApi {
  return usesChatGPTAuth(preset) ? "openai-responses" : (api ?? "anthropic-messages");
}
export function providerBaseUrl(preset: string, api = providerApi(preset)): string {
  const descriptor = getProviderPreset(preset);
  if (!descriptor || !providerApis(preset).includes(api)) throw new Error("configuration: 不支持的预置协议");
  return api === "anthropic-messages" ? anthropicBaseUrls[preset] : descriptor.baseUrl;
}
export function discoverProviderCredentials(env: Record<string, string | undefined>) {
  return providerPresets.flatMap((preset) => {
    const envKey = preset.envKeys.find(
      (key) =>
        env[key]?.trim() &&
        !Array.from(env[key] ?? "").some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ),
    );
    return envKey ? [{ preset: preset.id, envKey, apiKey: env[envKey] as string }] : [];
  });
}
