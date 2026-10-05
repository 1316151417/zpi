import { expect, it } from "vitest";
import {
  defaultThinkingLevel,
  fetchProviderModels,
  presetModels,
  reasoningParameters,
  thinkingChoices,
} from "../src/index.ts";

it("reads the account catalog without cache, uses slugs, and keeps new models distinct from unverified presets", async () => {
  const result = await fetchProviderModels({ preset: "openai-chatgpt", apiKey: "fake-token" }, (async (
    url,
    options,
  ) => {
    expect(String(url)).toBe("https://api.openai.com/v1/models");
    expect(options?.cache).toBe("no-store");
    return Response.json({
      data: [{ id: "stale-api-catalog" }],
      models: [
        { id: "internal-id", slug: "gpt-6-astra", visibility: "list", context_window: 300000 },
        { slug: "gpt-6-luna", visibility: "hide" },
        {
          slug: "new-account-model",
          visibility: "list",
          supported_reasoning_levels: ["none", "medium", "xhigh"],
        },
      ],
    });
  }) as typeof fetch);
  expect(result.models.map((model) => model.id)).toEqual(["gpt-6-astra", "new-account-model", "gpt-6.1-sol"]);
  expect(result.models[0]).toMatchObject({ availability: "listed", contextWindow: 300000 });
  expect(result.models[2]).toMatchObject({ availability: "unverified", defaultThinkingLevel: "medium" });
  expect(result.warning).toContain("账号可用性待验证");
  expect(thinkingChoices(result.models[1] as Parameters<typeof thinkingChoices>[0])).toEqual([
    "off",
    "medium",
    "xhigh",
  ]);
  expect(result.models[1].thinkingLevelMap?.max).toBeNull();
});

it("discovers newly returned GPT models with their complete efforts and account defaults", async () => {
  const result = await fetchProviderModels({ preset: "openai-chatgpt", apiKey: "fake" }, (async () =>
    Response.json({
      models: presetModels("openai-chatgpt").map((model) => ({
        slug: model.id,
        visibility: "list",
        supported_reasoning_levels: (model.id === "gpt-6-luna"
          ? ["none", "low", "medium", "high", "xhigh", "max"]
          : ["low", "medium", "high", "xhigh", "max"]
        ).map((effort) => ({ effort })),
        default_reasoning_level: "medium",
      })),
    })) as typeof fetch);
  expect(result.warning).toBeUndefined();
  for (const model of result.models) {
    const reasoningModel = { ...model, reasoning: true };
    expect(thinkingChoices(reasoningModel)).toEqual(
      model.id === "gpt-6-luna"
        ? ["off", "low", "medium", "high", "xhigh", "max"]
        : ["low", "medium", "high", "xhigh", "max"],
    );
    expect(defaultThinkingLevel(reasoningModel)).toBe("medium");
    expect(reasoningParameters(reasoningModel)).toEqual({ reasoning_effort: "medium" });
    expect(reasoningParameters(reasoningModel, "xhigh")).toEqual({ reasoning_effort: "xhigh" });
    expect(reasoningParameters(reasoningModel, "max")).toEqual({ reasoning_effort: "max" });
  }
});

it("never substitutes presets for failed or empty ChatGPT account discovery", async () => {
  for (const response of [new Response(null, { status: 401 }), Response.json({ models: [] })])
    await expect(
      fetchProviderModels(
        { preset: "openai-chatgpt", apiKey: "fake" },
        (async () => response) as typeof fetch,
      ),
    ).rejects.toThrow("无法获取模型");
});

it("Chinese catalogs offer only actual controls while keeping mapped levels usable", () => {
  const choices = (preset: string, id: string) => {
    const model = presetModels(preset).find((model) => model.id === id);
    if (!model) throw new Error("Missing preset model");
    return thinkingChoices({ ...model, reasoning: model.reasoning ?? false });
  };
  expect(choices("deepseek", "deepseek-flash")).toEqual(["off", "low", "high", "max"]);
  expect(choices("deepseek", "deepseek-v4-pro")).toEqual(["off", "high", "max"]);
  expect(choices("zhipu-api", "glm-5.3")).toEqual(["low", "high", "max"]);
  expect(choices("zhipu-api", "glm-4.7")).toEqual(["off", "high"]);
  expect(choices("minimax-api", "MiniMax-M2.7")).toEqual(["high"]);
  expect(choices("mimo-api", "mimo-v2.6-pro")).toEqual(["off", "high"]);
  const booleanModel = {
    reasoning: true,
    compat: { thinkingFormat: "zai" as const, supportsReasoningEffort: false },
  };
  expect(thinkingChoices(booleanModel)).toEqual(["off", "high"]);
  expect(reasoningParameters(booleanModel, "medium")).toEqual(reasoningParameters(booleanModel, "max"));
  const mapped = {
    reasoning: true,
    compat: { supportsReasoningEffort: true },
    thinkingLevelMap: { medium: "high", xhigh: "high", max: "high" },
  };
  expect(thinkingChoices(mapped)).toEqual(["off", "minimal", "low", "high"]);
  expect(reasoningParameters(mapped, "xhigh")).toEqual({ reasoning_effort: "high" });
});
