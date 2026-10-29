import { expect, it } from "vitest";
import {
  defaultThinkingLevel,
  fetchProviderModels,
  presetModels,
  reasoningParameters,
  thinkingChoices,
} from "../src/index.ts";

it.each([
  { api: "anthropic-messages" as const, key: "fake-api-key", path: "/v1/models", header: "x-api-key" },
  { api: "anthropic-messages" as const, key: "sk-ant-oat-fake", path: "/v1/models", header: "authorization" },
  { api: "openai-completions" as const, key: "fake-api-key", path: "/models", header: "authorization" },
])(
  "discovers custom $api models using their catalog protocol and $header",
  async ({ api, key, path, header }) => {
    const result = await fetchProviderModels({ api, baseUrl: "https://custom.example", apiKey: key }, (async (
      url,
      options,
    ) => {
      expect(String(url)).toBe(`https://custom.example${path}`);
      const headers = new Headers(options?.headers);
      expect(headers.get(header)).toBe(header === "authorization" ? `Bearer ${key}` : key);
      expect(headers.get("anthropic-version")).toBe(api === "anthropic-messages" ? "2023-06-01" : null);
      expect(headers.get(header === "authorization" ? "x-api-key" : "authorization")).toBeNull();
      return Response.json({ data: [{ id: "custom-model" }] });
    }) as typeof fetch);
    expect(result).toMatchObject({ source: "remote", models: [{ id: "custom-model" }] });
  },
);

it("keeps preset discovery on its OpenAI catalog when inference uses Anthropic", async () => {
  await fetchProviderModels({ preset: "deepseek", api: "anthropic-messages", apiKey: "fake" }, (async (
    url,
    options,
  ) => {
    expect(String(url)).toBe("https://api.deepseek.com/models");
    expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fake");
    return Response.json({ data: [{ id: "deepseek-flash" }] });
  }) as typeof fetch);
});

it("rejects failed custom Anthropic discovery without exposing credentials", async () => {
  await expect(
    fetchProviderModels(
      { api: "anthropic-messages", baseUrl: "https://custom.example", apiKey: "fake-secret" },
      (async () => new Response("fake-secret", { status: 401 })) as typeof fetch,
    ),
  ).rejects.toThrow("无法获取模型列表");
});

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
  expect(result.models.map((model) => model.id)).toEqual([
    "gpt-6.1-terra",
    "gpt-6.1-sol",
    "gpt-6-astra",
    "new-account-model",
  ]);
  expect(result.models[2]).toMatchObject({ availability: "listed", contextWindow: 300000 });
  expect(result.models[1]).toMatchObject({ availability: "unverified", defaultThinkingLevel: "medium" });
  expect(result.warning).toContain("账号可用性待验证");
  expect(thinkingChoices(result.models[3] as Parameters<typeof thinkingChoices>[0])).toEqual([
    "off",
    "medium",
    "xhigh",
  ]);
  expect(result.models[3].thinkingLevelMap?.max).toBeNull();
});

it("orders GPT presets Terra, Sol, Luna, Astra and provides Terra's default capabilities", () => {
  const models = presetModels("openai-chatgpt");
  expect(models.map((model) => model.id)).toEqual([
    "gpt-6.1-terra",
    "gpt-6.1-sol",
    "gpt-6-luna",
    "gpt-6-astra",
  ]);
  expect(models[0]).toMatchObject({
    name: "GPT-6.1 Terra",
    input: ["text", "image"],
    contextWindow: 1_050_000,
    maxTokens: 128_000,
    defaultThinkingLevel: "medium",
  });
  expect(thinkingChoices({ ...models[0], reasoning: true })).toEqual([
    "off",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
});

it("discovers newly returned GPT models with their complete efforts and account defaults", async () => {
  const result = await fetchProviderModels({ preset: "openai-chatgpt", apiKey: "fake" }, (async () =>
    Response.json({
      models: presetModels("openai-chatgpt")
        .toReversed()
        .map((model) => ({
          slug: model.id,
          visibility: "list",
          supported_reasoning_levels: (model.id === "gpt-6-luna" || model.id === "gpt-6.1-terra"
            ? ["none", "low", "medium", "high", "xhigh", "max"]
            : ["low", "medium", "high", "xhigh", "max"]
          ).map((effort) => ({ effort })),
          default_reasoning_level: "medium",
        })),
    })) as typeof fetch);
  expect(result.warning).toBeUndefined();
  expect(result.models.map((model) => model.id)).toEqual(
    presetModels("openai-chatgpt").map((model) => model.id),
  );
  for (const model of result.models) {
    const reasoningModel = { ...model, reasoning: true };
    expect(thinkingChoices(reasoningModel)).toEqual(
      model.id === "gpt-6-luna" || model.id === "gpt-6.1-terra"
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

it("discovers official API models with a bearer key, filters non-agent models and supplements missing presets", async () => {
  const result = await fetchProviderModels(
    { preset: "openai-api", api: "openai-responses", apiKey: "fake-api-key" },
    async (url, options) => {
      expect(String(url)).toBe("https://api.openai.com/v1/models");
      expect(new Headers(options?.headers).get("authorization")).toBe("Bearer fake-api-key");
      expect(options?.cache).toBe("no-store");
      return Response.json({
        data: [
          { id: "gpt-6-astra" },
          { id: "text-embedding-3-small" },
          { id: "gpt-6.1-sol" },
          { id: "gpt-image-1" },
        ],
      });
    },
  );
  expect(result.source).toBe("remote");
  expect(result.models.map((model) => model.id)).toEqual(
    presetModels("openai-chatgpt").map((model) => model.id),
  );
  expect(result.models.map((model) => model.availability)).toEqual([
    "unverified",
    "listed",
    "unverified",
    "listed",
  ]);
  expect(result.models[1]).toMatchObject({ reasoning: true, input: ["text", "image"], maxTokens: 128000 });
  expect(result.warning).toContain("账号可用性待验证");
});

it("uses all four API presets when discovery fails, is empty or lists no matching models", async () => {
  for (const response of [
    new Response("fake-secret", { status: 401 }),
    Response.json({ data: [] }),
    Response.json({ data: [{ id: "text-embedding-3-small" }] }),
    Response.json({
      data: [
        ...Array.from({ length: 500 }, (_, index) => ({ id: `embedding-${index}` })),
        { id: "gpt-6.1-sol" },
      ],
    }),
  ]) {
    const result = await fetchProviderModels(
      { preset: "openai-api", apiKey: "fake-secret" },
      async () => response,
    );
    expect(result.models).toEqual(presetModels("openai-chatgpt"));
    expect(result.warning).toBeDefined();
    expect(result.warning).not.toContain("fake-secret");
  }
});

it.each(["openai-responses", "openai-completions"] as const)(
  "discovers all four API models with %s",
  async (api) => {
    const result = await fetchProviderModels({ preset: "openai-api", api, apiKey: "fake" }, async () =>
      Response.json({
        data: presetModels("openai-api")
          .toReversed()
          .map(({ id }) => ({ id })),
      }),
    );
    expect(result.warning).toBeUndefined();
    expect(result.models).toEqual(
      presetModels("openai-chatgpt").map((model) => ({ ...model, availability: "listed" })),
    );
  },
);

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
