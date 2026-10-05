import { isJsonObject } from "../utils/transcript.ts";
import type { DiscoveredModel, ProviderPresetId } from "./registry.ts";
import { getProviderPreset, presetModels, usesChatGPTAuth } from "./registry.ts";

export interface ModelDiscoveryInput {
  preset?: ProviderPresetId;
  baseUrl?: string;
  apiKey: string;
}
export interface ModelDiscoveryResult {
  models: DiscoveredModel[];
  source: "remote" | "catalog";
  warning?: string;
}
const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
function normalizeModel(
  value: unknown,
  input: ModelDiscoveryInput,
  catalog: ReadonlyMap<string, DiscoveredModel>,
): DiscoveredModel | undefined {
  const item = typeof value === "string" ? { id: value } : value;
  if (!isJsonObject(item)) return;
  if (usesChatGPTAuth(input.preset) && item.visibility !== "list") return;
  const chatgpt = usesChatGPTAuth(input.preset);
  const id = chatgpt ? (item.slug ?? item.id) : (item.id ?? item.slug);
  if (typeof id !== "string" || !id.trim() || id.length > 200) return;
  const known = catalog.get(id.toLowerCase());
  const model: DiscoveredModel = known
    ? structuredClone(known)
    : {
        id,
        input: ["text"],
        reasoning: false,
        contextWindow: 32768,
        maxTokens: 4096,
        compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
      };
  model.id = id;
  const name = item.display_name ?? item.name;
  if (typeof name === "string" && name.trim()) model.name = name.slice(0, 200);
  const contextWindow = positive(item.context_window ?? item.contextWindow ?? item.context_length);
  const maxTokens = positive(item.max_output_tokens ?? item.maxTokens ?? item.max_tokens);
  if (contextWindow) model.contextWindow = contextWindow;
  if (maxTokens && maxTokens <= (model.contextWindow ?? 32768)) model.maxTokens = maxTokens;
  if ((model.maxTokens ?? 0) > (model.contextWindow ?? 0))
    model.maxTokens = Math.min(4096, model.contextWindow ?? 32768);
  const modalities = item.input_modalities ?? item.input;
  if (Array.isArray(modalities)) {
    model.input = [
      "text",
      ...modalities.filter((type): type is "image" | "video" | "pdf" =>
        ["image", "video", "pdf"].includes(String(type)),
      ),
    ];
  }
  if (usesChatGPTAuth(input.preset)) {
    model.availability = "listed";
    if (item.supports_image_inputs === true) model.input = ["text", "image"];
    const levels = item.supported_reasoning_levels ?? item.supported_reasoning_efforts;
    const supported = Array.isArray(levels)
      ? levels.flatMap((value) =>
          typeof value === "string"
            ? [value]
            : isJsonObject(value) && typeof value.effort === "string"
              ? [value.effort]
              : [],
        )
      : [];
    if (supported.length) {
      model.reasoning = supported.some((level) => level !== "none");
      model.compat = { supportsReasoningEffort: true };
      model.thinkingLevelMap = Object.fromEntries(
        ["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
          level,
          level === "off"
            ? supported.includes("none")
              ? "none"
              : null
            : supported.includes(level)
              ? level
              : null,
        ]),
      );
      const defaultLevel = item.default_reasoning_level ?? item.default_reasoning_effort;
      const defaultThinkingLevel = (
        typeof defaultLevel === "string" && supported.includes(defaultLevel)
          ? defaultLevel === "none"
            ? "off"
            : defaultLevel
          : supported.includes("medium")
            ? "medium"
            : undefined
      ) as DiscoveredModel["defaultThinkingLevel"];
      if (defaultThinkingLevel) model.defaultThinkingLevel = defaultThinkingLevel;
      else delete model.defaultThinkingLevel;
    }
  }
  const effort = isJsonObject(item.effort) ? item.effort.supported_levels : undefined;
  if (Array.isArray(effort) && input.preset === "deepseek") {
    model.reasoning = true;
    model.compat = { ...model.compat, thinkingFormat: "deepseek", supportsReasoningEffort: true };
    model.thinkingLevelMap = Object.fromEntries(
      ["minimal", "low", "medium", "high", "xhigh", "max"].map((level) => [
        level,
        effort.includes(level) ? level : null,
      ]),
    );
  }
  model.metadataSource =
    contextWindow && maxTokens && Array.isArray(modalities) ? "remote" : known ? "catalog" : "defaults";
  return model;
}
export async function fetchProviderModels(
  input: ModelDiscoveryInput,
  fetcher: typeof fetch = fetch,
): Promise<ModelDiscoveryResult> {
  const preset = input.preset ? getProviderPreset(input.preset) : undefined;
  if (input.preset && !preset) throw new Error("configuration: 未知预置提供商");
  const baseUrl = preset?.baseUrl ?? input.baseUrl;
  if (!baseUrl) throw new Error("configuration: 缺少 API 地址");
  const url = new URL(`${baseUrl.replace(/\/$/, "")}/models`);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("configuration: 无效 API 地址");
  const catalog = presetModels(input.preset ?? "");
  const modelsById = new Map(catalog.map((model) => [model.id.toLowerCase(), model]));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetcher(url, {
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
      },
      signal: controller.signal,
      cache: "no-store",
      redirect: "error",
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`HTTP ${response.status}`);
    }
    const reader = response.body?.getReader();
    if (!reader) throw new Error("空响应");
    const parts: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("模型目录过大");
        }
        parts.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const part of parts) {
      bytes.set(part, offset);
      offset += part.length;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(bytes));
    const container = isJsonObject(data)
      ? usesChatGPTAuth(input.preset)
        ? (data.models ?? data.data)
        : (data.data ?? data.models)
      : data;
    const entries = Array.isArray(container)
      ? container
      : isJsonObject(container) && Array.isArray(container.models)
        ? container.models
        : [];
    const models = [
      ...new Map(
        entries.slice(0, 500).flatMap((value) => {
          const model = normalizeModel(value, input, modelsById);
          return model ? [[model.id, model] as const] : [];
        }),
      ).values(),
    ];
    if (!models.length) throw new Error("未返回可用模型");
    if (usesChatGPTAuth(input.preset)) {
      // Only supplement models absent from the response, never ones explicitly hidden by the account.
      const returned = new Set(
        entries.flatMap((item) =>
          isJsonObject(item) && typeof (item.slug ?? item.id) === "string" ? [item.slug ?? item.id] : [],
        ),
      );
      const supplemental = catalog.filter((model) => !returned.has(model.id));
      return {
        models: [...models, ...supplemental],
        source: "remote",
        ...(supplemental.length
          ? {
              warning: `已获取账号模型目录；${supplemental.map((model) => model.name).join("、")} 为预置补充，账号可用性待验证。`,
            }
          : {}),
      };
    }
    return { models, source: "remote" };
  } catch (error) {
    const models = catalog.map((model) => ({
      ...model,
      metadataSource: "catalog" as const,
    }));
    if (!models.length || usesChatGPTAuth(input.preset))
      throw new Error("provider: 无法获取模型列表，请检查地址、凭据和网络");
    // Never include response bodies, headers or credentials in diagnostics.
    const status = error instanceof Error && /^HTTP \d{3}$/.test(error.message) ? `（${error.message}）` : "";
    return { models, source: "catalog", warning: `在线模型列表暂不可用${status}，保留 Pi 预置目录。` };
  } finally {
    clearTimeout(timer);
  }
}
