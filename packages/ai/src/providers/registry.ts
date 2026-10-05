import type { Model, OpenAICompletionsCompat } from "../types.ts";
import catalog from "./catalog.json" with { type: "json" };

export interface DiscoveredModel {
  id: string;
  name?: string;
  input?: ("text" | "image" | "video" | "pdf")[];
  reasoning?: boolean;
  contextWindow?: number;
  maxTokens?: number;
  compat?: OpenAICompletionsCompat;
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
export function presetModels(id: string): DiscoveredModel[] {
  const preset = getProviderPreset(id);
  return preset?.catalog ? (structuredClone(catalog[preset.catalog]) as DiscoveredModel[]) : [];
}
export function usesChatGPTAuth(preset?: string): boolean {
  return preset === "openai-chatgpt";
}
export function providerApi(preset?: string): Model["api"] {
  return usesChatGPTAuth(preset) ? "openai-responses" : "openai-completions";
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
