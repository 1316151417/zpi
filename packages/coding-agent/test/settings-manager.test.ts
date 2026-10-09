import { clampThinkingLevel, createAssistantMessageEventStream, emptyAssistant } from "ZPI-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "ZPI-coding-agent";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

it("loads global/project settings with recursive overrides and Pi defaults", async () => {
  const cwd = await directory();
  const agentDir = join(cwd, "agent");
  await mkdir(agentDir);
  await mkdir(join(cwd, ".ZPI"));
  await writeFile(
    join(agentDir, "settings.json"),
    JSON.stringify({
      defaultThinkingLevel: "high",
      compaction: { reserveTokens: 1000, modelOverrides: { "fake/fake": { keepRecentTokens: 10 } } },
      retry: { baseDelayMs: 100, provider: { maxRetries: 1 } },
    }),
  );
  await writeFile(
    join(cwd, ".ZPI/settings.json"),
    JSON.stringify({
      compaction: { modelOverrides: { "fake/fake": { reserveTokens: 0 } } },
      retry: { provider: { timeoutMs: 500 } },
    }),
  );
  const settings = SettingsManager.create(cwd, agentDir);
  expect(settings.getDefaultThinkingLevel()).toBe("high");
  expect(settings.getCompactionSettings(fakeModel(""))).toEqual({
    enabled: true,
    reserveTokens: 0,
    keepRecentTokens: 10,
  });
  expect(settings.getCompactionSettings()).toEqual({
    enabled: true,
    reserveTokens: 1000,
    keepRecentTokens: 20000,
  });
  expect(settings.getRetrySettings()).toEqual({
    enabled: true,
    maxRetries: 3,
    baseDelayMs: 100,
    maxAgentDelayMs: 60000,
  });
  expect(settings.getProviderRetrySettings()).toEqual({
    maxRetries: 1,
    timeoutMs: 500,
    maxRetryDelayMs: 60000,
  });
  const defaults = SettingsManager.inMemory();
  expect(defaults.getCompactionSettings()).toEqual({
    enabled: true,
    reserveTokens: 16384,
    keepRecentTokens: 20000,
  });
  expect(defaults.getHttpIdleTimeoutMs()).toBe(300000);
  settings.applyOverrides({ compaction: { reserveTokens: -1 } });
  expect(() => settings.getCompactionSettings(fakeModel(""))).toThrow("non-negative safe integer");
});

it("parses Pi HTTP timeout values and reports invalid files without discarding valid settings", async () => {
  expect(SettingsManager.inMemory({ httpIdleTimeoutMs: " disabled " }).getHttpIdleTimeoutMs()).toBe(0);
  expect(SettingsManager.inMemory({ httpIdleTimeoutMs: " 12.9 " }).getHttpIdleTimeoutMs()).toBe(12);
  for (const value of ["", " ", "bad", -1, Infinity])
    expect(() => SettingsManager.inMemory({ httpIdleTimeoutMs: value }).getHttpIdleTimeoutMs()).toThrow(
      "Invalid httpIdleTimeoutMs",
    );
  const cwd = await directory();
  await mkdir(join(cwd, ".ZPI"));
  await writeFile(join(cwd, ".ZPI/settings.json"), "bad json");
  expect(SettingsManager.create(cwd, cwd).getErrors()).toHaveLength(1);
});

it("chooses explicit, restored, per-model, global and medium reasoning in Pi order", async () => {
  const runtime = await ModelRuntime.create();
  const model = { ...fakeModel("http://local"), compat: { supportsReasoningEffort: true } };
  runtime.registerProvider("fake", {
    apiKey: "local",
    models: [{ ...fakeConfig("http://local"), compat: model.compat }],
  });
  async function chosen(
    settingsManager: SettingsManager,
    manager = SessionManager.inMemory(),
    thinkingLevel?: string,
  ) {
    const { session } = await createAgentSession({
      modelRuntime: runtime,
      model,
      sessionManager: manager,
      settingsManager,
      thinkingLevel,
      noTools: "all",
      resourceLoader: new StaticResourceLoader(),
    });
    const result = session.thinkingLevel;
    session.dispose();
    return result;
  }
  const settings = SettingsManager.inMemory({
    defaultThinkingLevel: "low",
    modelThinkingLevels: { "fake/fake": "high" },
  });
  expect(await chosen(settings)).toBe("high");
  expect(await chosen(settings, SessionManager.inMemory(), "max")).toBe("max");
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "restored", timestamp: 1 });
  manager.appendThinkingLevelChange("minimal");
  expect(await chosen(settings, manager)).toBe("minimal");
  expect(await chosen(SettingsManager.inMemory({ defaultThinkingLevel: "low" }))).toBe("low");
  expect(await chosen(SettingsManager.inMemory())).toBe("medium");
  const limited = {
    ...model,
    reasoningConfig: { levels: ["off", "low", "high"], map: '{"reasoning_effort": reasoningLevel}' },
  };
  expect(clampThinkingLevel(limited, "medium")).toBe("high");
  expect(clampThinkingLevel(limited, "max")).toBe("high");
  expect(clampThinkingLevel({ ...model, reasoning: false }, "max")).toBe("off");
});

it("applies provider timeout/retry settings to both normal and summary requests", async () => {
  const cwd = await directory();
  const requests: import("ZPI-ai").SimpleStreamOptions[] = [];
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, _context, options) {
      requests.push(options ?? {});
      const stream = createAssistantMessageEventStream();
      stream.end({
        ...emptyAssistant(model),
        content: [{ type: "text", text: "answer ".repeat(100) }],
        stopReason: "stop",
      });
      return stream;
    },
  });
  const settings = SettingsManager.inMemory({
    httpIdleTimeoutMs: "disabled",
    retry: { provider: { timeoutMs: 1234, maxRetries: 1, maxRetryDelayMs: 2000 } },
    compaction: { enabled: false, keepRecentTokens: 0 },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    modelRuntime: runtime,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(cwd),
    noTools: "all",
    resourceLoader: new StaticResourceLoader(),
  });
  try {
    await session.prompt("task");
    await session.compact();
    expect(requests).toHaveLength(2);
    for (const options of requests)
      expect(options).toMatchObject({ timeoutMs: 1234, maxRetries: 1, maxRetryDelayMs: 2000 });
    expect(requests[1].cacheRetention).toBe("none");
    expect(requests[1].sessionId).not.toBe(requests[0].sessionId);
  } finally {
    session.dispose();
  }
});
