import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { JsonObject, Model, ProviderApi } from "zpi-ai";
import { ModelRuntime, type ProviderConfigInput } from "zpi-coding-agent";
import { chunk } from "../../../tests/fake-server.ts";
import { modelRuntimeConfig } from "../src/main/model-runtime-config.ts";
import { QuickChatHost } from "../src/main/quick-chat-host.ts";
import { SessionHost } from "../src/main/session-host.ts";
import * as storage from "../src/main/storage.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
type Snapshot = ReturnType<storage.SettingsStore["snapshot"]>;
const snapshot = (): Snapshot => ({
  id: "custom",
  name: "Custom provider",
  baseUrl: "https://models.example/v1",
  apiKey: "synthetic-key",
  models: [
    {
      id: "advanced",
      name: " Advanced model ",
      input: ["text", "image", "video", "pdf"],
      reasoning: true,
      contextWindow: 64000,
      maxTokens: 8192,
      compat: {
        maxTokensField: "max_completion_tokens",
        supportsReasoningEffort: false,
        supportsUsageInStreaming: false,
        supportsDeveloperRole: false,
        structuredOutput: "json_schema",
        thinkingFormat: "deepseek",
        requiresReasoningContentOnAssistantMessages: true,
        supportsEagerToolInputStreaming: false,
        sendSessionAffinityHeaders: true,
        supportsLongCacheRetention: false,
      },
      thinkingLevelMap: { off: "none", high: { thinking_budget: 2048, reasoning_budget: 1024 }, max: null },
      reasoningConfig: {
        levels: ["off", "high"],
        map: '{"reasoning_effort": reasoningLevel, "thinking_budget": 2048}',
      },
      defaultThinkingLevel: "high",
      samplingParams: { temperature: 0.4, top_p: 0.8, stream_options: { include_usage: false } },
      enabled: true,
      useRecommendedConfig: false,
      metadataSource: "remote",
      availability: "unverified",
    },
    { id: "disabled", enabled: false },
    { id: "defaults" },
  ],
});
const expectedModels = (): NonNullable<ProviderConfigInput["models"]> => [
  {
    id: "advanced",
    name: "Advanced model",
    api: "openai-completions",
    input: ["text", "image"],
    reasoning: true,
    contextWindow: 64000,
    maxTokens: 8192,
    compat: {
      supportsReasoningEffort: false,
      maxTokensField: "max_completion_tokens",
      supportsUsageInStreaming: false,
      supportsDeveloperRole: false,
      structuredOutput: "json_schema",
      thinkingFormat: "deepseek",
      requiresReasoningContentOnAssistantMessages: true,
      supportsEagerToolInputStreaming: false,
      sendSessionAffinityHeaders: true,
      supportsLongCacheRetention: false,
    },
    reasoningConfig: {
      levels: ["off", "high"],
      map: '{"reasoning_effort": reasoningLevel, "thinking_budget": 2048}',
    },
    thinkingLevelMap: { off: "none", high: { thinking_budget: 2048, reasoning_budget: 1024 }, max: null },
    defaultThinkingLevel: "off",
    samplingParams: { temperature: 0.4, top_p: 0.8, stream_options: { include_usage: false } },
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "defaults",
    name: "defaults",
    api: "openai-completions",
    input: ["text"],
    reasoning: true,
    contextWindow: 1000000,
    maxTokens: 128000,
    compat: { supportsReasoningEffort: true },
    defaultThinkingLevel: "medium",
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
];

test("maps all runtime fields without mutating the snapshot or retaining desktop model metadata", () => {
  const config = snapshot();
  const before = structuredClone(config);
  const getApiKey = vi.fn(async () => "unused");
  expect(modelRuntimeConfig(config, getApiKey)).toStrictEqual({
    baseUrl: "https://models.example/v1",
    apiKey: "synthetic-key",
    models: expectedModels(),
  });
  expect(config).toStrictEqual(before);
  expect(getApiKey).not.toHaveBeenCalled();
});

test.each<ProviderApi>(["openai-completions", "openai-responses", "anthropic-messages"])(
  "preserves the selected %s API on every enabled model",
  (api) => {
    expect(modelRuntimeConfig({ ...snapshot(), api }, async () => "unused").models).toStrictEqual(
      expectedModels().map((model) => ({ ...model, api })),
    );
  },
);

test("ChatGPT selects Responses and retains its lazy request-time credential getter", async () => {
  let key = "first-token";
  const getApiKey = vi.fn(async () => key);
  const configured = modelRuntimeConfig(
    { ...snapshot(), preset: "openai-chatgpt", api: "openai-completions", apiKey: "" },
    getApiKey,
  );
  expect(configured).toStrictEqual({
    baseUrl: "https://models.example/v1",
    apiKey: "",
    getApiKey,
    models: expectedModels().map((model) => ({ ...model, api: "openai-responses", auth: "chatgpt" })),
  });
  expect(getApiKey).not.toHaveBeenCalled();
  expect(await configured.getApiKey?.()).toBe("first-token");
  key = "refreshed-token";
  expect(await configured.getApiKey?.()).toBe("refreshed-token");
});

test("forwards resolved model headers and pricing alongside every optional runtime field", () => {
  const config = snapshot();
  const resolved: Model = {
    ...storage.resolveModel(config, config.models[0]),
    headers: { "x-model-version": "canary" },
    cost: {
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.2,
      tiers: [{ inputTokensAbove: 32000, input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0.4 }],
    },
  };
  const resolve = vi.spyOn(storage, "resolveModel").mockReturnValue(resolved);
  const configured = modelRuntimeConfig({ ...config, models: [config.models[0]] }, async () => "unused");
  expect(configured.models).toStrictEqual([
    { ...expectedModels()[0], headers: resolved.headers, cost: resolved.cost },
  ]);
  expect(resolve).toHaveBeenCalledExactlyOnceWith(
    { ...config, models: [config.models[0]] },
    config.models[0],
  );
});

test.each(["quick", "task"] as const)(
  "%s host registers the accepted snapshot after initialization and preserves request configuration",
  async (kind) => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-runtime-config-"));
    cleanup.push(() => rm(dir, { recursive: true, force: true }));
    const settings = new storage.SettingsStore(join(dir, "settings"), {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from(value),
      decryptString: (value) => value.toString(),
    });
    cleanup.push(() => settings.close());
    const config = snapshot();
    // Real Completions requests reject Anthropic-only compatibility keys.
    delete config.models[0].compat?.supportsEagerToolInputStreaming;
    delete config.models[0].compat?.sendSessionAffinityHeaders;
    delete config.models[0].compat?.supportsLongCacheRetention;
    settings.saveProvider(config);
    settings.rememberSelection({ provider: "custom", modelId: "advanced", reasoning: "high" });
    const registrations = vi.spyOn(ModelRuntime.prototype, "registerProvider");
    const clears = vi.spyOn(ModelRuntime.prototype, "clearProviders");
    const requests: { url: string; authorization: string | null; body: JsonObject }[] = [];
    const transport: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      requests.push({
        url: request.url,
        authorization: request.headers.get("authorization"),
        body: (await request.json()) as JsonObject,
      });
      return new Response(
        `data: ${JSON.stringify(chunk({ content: "answer" }))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    let idle: Promise<unknown>;
    if (kind === "quick") {
      const host = new QuickChatHost(settings, join(dir, "workspace"), transport);
      cleanup.push(() => host.close());
      host.send("hello");
      idle = host.waitForIdle();
    } else {
      const host = new SessionHost(dir, settings, join(dir, "home"), dir, transport);
      cleanup.push(() => host.close());
      await host.init();
      const task = await host.createSession(null, { cwd: dir });
      // Naming is a separate runtime; this test isolates the ordinary task request.
      const record = settings.state.getTask(task.id);
      if (!record) throw new Error("Missing task");
      settings.state.upsertTask({ ...record, titleState: "generated" });
      idle = host
        .startRun({ sessionId: task.id, text: "hello" })
        .then(() => host.activeRuns.get(task.id)?.done);
    }
    settings.saveProvider({ ...config, baseUrl: "https://changed.example/v1", apiKey: "new-key" });
    await idle;
    const expected: ProviderConfigInput = {
      baseUrl: "https://models.example/v1",
      apiKey: "synthetic-key",
      models: expectedModels().map((model, index) =>
        index === 0 ? { ...model, compat: config.models[0].compat } : model,
      ),
    };
    expect(registrations).toHaveBeenCalledExactlyOnceWith("custom", expected);
    expect(clears).toHaveBeenCalledTimes(1);
    expect(clears.mock.invocationCallOrder[0]).toBeLessThan(registrations.mock.invocationCallOrder[0]);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      url: "https://models.example/v1/chat/completions",
      authorization: "Bearer synthetic-key",
      body: {
        model: "advanced",
        max_completion_tokens: 8192,
        reasoning_effort: kind === "quick" ? "off" : "high",
        thinking_budget: 2048,
        stream_options: { include_usage: false },
        temperature: 0.4,
        top_p: 0.8,
      },
    });
  },
);
