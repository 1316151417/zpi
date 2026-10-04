import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { fetchProviderModels, normalizeContext } from "zpi-ai";
import { streamSimple } from "zpi-ai/api/openai-completions";
import { chunk, done, fakeServer, send } from "../../../tests/fake-server.ts";
import { reasoningParameters } from "../../ai/src/utils/reasoning.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { availablePresets } from "../src/shared/config.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((f) => f()),
  );
});
const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (v: string) => Buffer.from(v),
  decryptString: (v: Buffer) => v.toString(),
};
async function directory() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-models-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

it("two providers each save multiple models; defaults, advanced fields, keep/clear credentials and deletion are real", async () => {
  const dir = await directory(),
    settings = new SettingsStore(dir, codec);
  settings.saveProvider({
    id: "one",
    name: "First",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKey: "key-one",
    models: [
      { id: "same" },
      {
        id: "advanced",
        reasoning: true,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: { max: null },
        samplingParams: { temperature: 0.2 },
      },
    ],
  });
  settings.saveProvider({
    id: "two",
    name: "Second",
    baseUrl: "http://127.0.0.1:9000/v1",
    models: [{ id: "same" }, { id: "other" }],
  });
  expect(settings.getModel({ provider: "one", modelId: "same" })).toMatchObject({
    contextWindow: 1000000,
    maxTokens: 128000,
    input: ["text"],
    reasoning: true,
  });
  expect(settings.get().providers.map((p) => p.models.length)).toEqual([2, 2]);
  expect(JSON.stringify(settings.get())).not.toContain("key-one");
  const one = settings.get().providers.find((p) => p.id === "one");
  if (!one) throw new Error("Missing provider");
  const input = { id: one.id, name: one.name, baseUrl: one.baseUrl, models: one.models };
  settings.saveProvider(input);
  expect(settings.get().providers.map((provider) => provider.id)).toEqual(["one", "two"]);
  settings.reorderProviders(["two", "one"]);
  settings.saveProvider({ ...input, models: [...input.models].reverse() });
  const reopened = new SettingsStore(dir, codec).get();
  expect(reopened.providers.map((provider) => provider.id)).toEqual(["two", "one"]);
  expect(reopened.providers[1].models.map((model) => model.id)).toEqual(["advanced", "same"]);
  expect(() => settings.reorderProviders(["one", "one"])).toThrow("全部提供商");
  expect(settings.snapshot("one").apiKey).toBe("key-one");
  settings.saveProvider({ ...input, apiKey: "" });
  expect(settings.snapshot("one").apiKey).toBe("");
  settings.deleteProvider("one");
  expect(settings.getModel({ provider: "one", modelId: "same" })).toBeUndefined();
  expect(new SettingsStore(dir, codec).get().providers).toHaveLength(1);
  expect(() => settings.saveProvider({ name: "", baseUrl: "bad", models: [{ id: "" }] })).toThrow();
  expect(() =>
    settings.saveProvider({
      name: "Bad",
      baseUrl: "http://localhost/v1",
      models: [{ id: "x", contextWindow: 1, maxTokens: 2 }],
    }),
  ).toThrow("上下文容量");
});
it("session models and thinking persist on both lazy and live SDK paths; deleted selections never fall back", async () => {
  const dir = await directory(),
    settings = new SettingsStore(dir, codec);
  const server = await fakeServer((_, r) => {
    send(r, chunk({ content: "answer" }));
    done(r);
  });
  cleanup.push(server.close);
  settings.saveProvider({
    id: "one",
    name: "First",
    baseUrl: server.url,
    models: [
      { id: "plain", reasoning: false },
      {
        id: "reason",
        reasoning: true,
        compat: { supportsReasoningEffort: true },
        thinkingLevelMap: { max: null },
      },
    ],
  });
  settings.saveProvider({
    id: "two",
    name: "Second",
    baseUrl: server.url,
    models: [{ id: "plain", reasoning: false }],
  });
  settings.rememberSelection({
    provider: settings.get().providers[0].id,
    modelId: settings.get().providers[0].models[0].id,
    reasoning: "disabled",
  });
  const host = new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined, []);
  await host.init();
  cleanup.push(() => host.close());
  const project = await host.addProject(dir),
    a = host.createSession(project.id),
    b = host.createSession(project.id);
  await mkdir(join(dir, "agent", "AGENTS.md"), { recursive: true });
  expect((await host.listSkills(project.id)).diagnostics).toContainEqual({
    path: join(dir, "agent", "AGENTS.md"),
    message: expect.stringContaining("EISDIR"),
  });
  await host.setSessionSelection(a.id, { provider: "one", modelId: "reason", reasoning: "high" });
  await host.setSessionSelection(b.id, { provider: "two", modelId: "plain", reasoning: "disabled" });
  expect(host.getSessionSnapshot(a.id).controls.thinkingLevel).toBe("high");
  await expect(
    host.setSessionSelection(a.id, { provider: "one", modelId: "reason", reasoning: "max" }),
  ).rejects.toThrow("不可用");
  await host.startRun({ sessionId: a.id, text: "first" });
  await host.activeRuns.get(a.id)?.done;
  expect(server.requests[0]).toMatchObject({ model: "reason", reasoning_effort: "high" });
  await host.setSessionSelection(a.id, { provider: "two", modelId: "plain", reasoning: "disabled" });
  expect(host.getSessionSnapshot(a.id).controls).toMatchObject({
    thinkingLevel: "off",
    lastThinkingLevel: "high",
  });
  expect(host.getSessionSnapshot(b.id).controls.model).toEqual({ provider: "two", modelId: "plain" });
  const restarted = new SessionHost(
    dir,
    new SettingsStore(dir, codec),
    join(dir, "agent"),
    undefined,
    undefined,
    [],
  );
  await restarted.init();
  cleanup.push(() => restarted.close());
  expect(restarted.getSessionSnapshot(a.id).controls.model).toEqual({ provider: "two", modelId: "plain" });
  settings.deleteProvider("two");
  await expect(host.startRun({ sessionId: a.id, text: "deleted model" })).rejects.toThrow("已删除");
  expect(host.getSessionSnapshot(a.id).controls.model).toEqual({ provider: "two", modelId: "plain" });
});

it("environment discovery persists private preset credentials; models normalize full/list-only metadata with Pi fallback", async () => {
  const dir = await directory();
  const settings = new SettingsStore(dir, codec);
  const env = {
    DEEPSEEK_API_KEY: "private-deepseek",
    ZHIPU_API_KEY: "private-zhipu",
    MINIMAX_PAYGO_API_KEY: "private-minimax",
    MIMO_API_KEY: "private-mimo",
    ANTHROPIC_API_KEY: "ignored",
  };
  expect(settings.discoverEnvironment(env)).toHaveLength(4);
  const restarted = new SettingsStore(dir, codec);
  expect(restarted.discoverEnvironment(env)).toEqual([]);
  expect(restarted.snapshot("env-deepseek").apiKey).toBe(env.DEEPSEEK_API_KEY);
  expect(JSON.stringify(restarted.get())).not.toContain("private-");
  expect(restarted.get().providers.map((provider) => provider.preset)).toEqual([
    "deepseek",
    "zhipu-coding",
    "minimax-api",
    "mimo-coding",
  ]);
  const deepseek = await fetchProviderModels({ preset: "deepseek", apiKey: "test-key" }, (async (
    url,
    init,
  ) => {
    expect(String(url)).toBe("https://api.deepseek.com/models");
    expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer test-key");
    return Response.json({
      data: [
        {
          id: "deepseek-flash",
          name: "Flash",
          context_window: 1000000,
          max_output_tokens: 384000,
          input_modalities: ["text", "image"],
          effort: { supported_levels: ["low", "high", "max"] },
        },
      ],
    });
  }) as typeof fetch);
  expect(deepseek.models[0]).toMatchObject({
    contextWindow: 1000000,
    maxTokens: 384000,
    input: ["text", "image"],
    metadataSource: "remote",
  });
  const zhipu = await fetchProviderModels({ preset: "zhipu-coding", apiKey: "test-key" }, (async (url) => {
    expect(String(url)).toBe("https://open.bigmodel.cn/api/coding/paas/v4/models");
    return Response.json({ data: [{ id: "GLM-5.3" }] });
  }) as typeof fetch);
  expect(zhipu.models[0]).toMatchObject({
    id: "GLM-5.3",
    contextWindow: 1000000,
    metadataSource: "catalog",
    compat: { thinkingFormat: "zai" },
  });
  const resolved = settings.getModel({ provider: "env-deepseek", modelId: "deepseek-flash" });
  if (!resolved) throw new Error("Missing discovered model");
  expect(reasoningParameters(resolved, "off")).toEqual({ thinking: { type: "disabled" } });
  expect(reasoningParameters(resolved, "high")).toEqual({
    thinking: { type: "enabled" },
    reasoning_effort: "high",
  });
  const fallback = await fetchProviderModels(
    { preset: "minimax-api", apiKey: "private-key" },
    (async () => new Response("private-key", { status: 404 })) as typeof fetch,
  );
  expect(fallback.source).toBe("catalog");
  expect(fallback.models.length).toBeGreaterThan(0);
  expect(fallback.warning).not.toContain("private-key");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "discovered model reply" }));
    done(response);
  });
  cleanup.push(server.close);
  const host = new SessionHost(
    dir,
    settings,
    join(dir, "agent"),
    join(dir, "workspace"),
    ((_, init) => fetch(`${server.url}/chat/completions`, init)) as typeof fetch,
    [],
  );
  await host.init();
  cleanup.push(() => host.close());
  for (const provider of settings.get().providers) {
    const model = provider.models[0];
    const task = host.createSession(null);
    await host.setSessionSelection(task.id, {
      provider: provider.id,
      modelId: model.id,
      reasoning: availablePresets(model)[0],
    });
    await host.startRun({ sessionId: task.id, text: "use discovered model" });
    await host.activeRuns.get(task.id)?.done;
    expect(host.getSessionSnapshot(task.id).view.runs.at(-1)?.status).toBe("completed");
  }
  const disabled = settings.snapshot("env-zhipu-coding");
  settings.saveProvider({
    ...disabled,
    models: disabled.models.map((model) => ({ ...model, enabled: false })),
  });
  const choice = { provider: disabled.id, modelId: disabled.models[0].id, reasoning: "high" as const };
  expect(settings.getModel(choice)).toBeUndefined();
  expect(
    new SettingsStore(dir, codec).get().providers.find((provider) => provider.id === disabled.id)?.models[0]
      .enabled,
  ).toBe(false);
  await expect(host.setSessionSelection(host.createSession(null).id, choice)).rejects.toThrow("关闭");
  settings.saveProvider({ ...disabled, enabled: false });
  expect(settings.isSelectionValid(choice)).toBe(false);
  settings.saveProvider({ ...disabled, enabled: true });
  expect(settings.isSelectionValid(choice)).toBe(true);
  const snapshot = settings.snapshot("env-deepseek");
  settings.saveProvider({
    ...snapshot,
    models: deepseek.models.map((model) => ({ ...model, useRecommendedConfig: true })),
  });
  expect(
    new SettingsStore(dir, codec).get().providers.find((provider) => provider.id === "env-deepseek")
      ?.models[0],
  ).toMatchObject({ metadataSource: "remote", useRecommendedConfig: true });
  settings.saveProvider({ ...snapshot, models: [] });
  const afterDeletion = new SettingsStore(dir, codec);
  expect(afterDeletion.discoverEnvironment(env)).toEqual([]);
  expect(afterDeletion.snapshot("env-deepseek").models).toEqual([]);
});

it("preset models are selectable and use their declared thinking wire formats in a real local stream", async () => {
  const settings = new SettingsStore(await directory(), codec);
  settings.discoverEnvironment({
    DEEPSEEK_API_KEY: "test",
    ZHIPU_API_KEY: "test",
    MINIMAX_API_KEY: "test",
    MIMO_API_KEY: "test",
  });
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  cleanup.push(server.close);
  for (const provider of settings.get().providers) {
    expect(provider.models.every((model) => availablePresets(model).length > 0)).toBe(true);
    const model = settings.getModel({ provider: provider.id, modelId: provider.models[0].id });
    if (!model) throw new Error("Missing preset model");
    const result = await streamSimple({ ...model, baseUrl: server.url }, normalizeContext({ messages: [] }), {
      apiKey: "test",
      reasoning: "high",
    }).result();
    expect(result.stopReason).toBe("stop");
  }
  expect(server.requests.map((body) => body.thinking)).toEqual([
    { type: "enabled" },
    { type: "enabled", clear_thinking: false },
    { type: "adaptive" },
    { type: "enabled" },
  ]);
});
