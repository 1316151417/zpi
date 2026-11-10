import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, deferred, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { mergeDiscoveredModels } from "../src/shared/config.ts";
import { supportsFastMode, withFastMode } from "../src/shared/fast-mode.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("uses preset capabilities for existing configurations and respects explicit account restrictions", () => {
  for (const preset of ["openai-api", "openai-chatgpt"] as const) {
    expect(supportsFastMode({ preset }, { id: "gpt-6.1-sol" })).toBe(true);
    expect(supportsFastMode({ preset }, { id: "gpt-6.1-sol", serviceTiers: [] })).toBe(false);
  }
  expect(supportsFastMode({}, { id: "gpt-6.1-sol" })).toBe(false);
  expect(supportsFastMode({ api: "anthropic-messages" }, { id: "custom", serviceTiers: ["priority"] })).toBe(
    false,
  );
  expect(
    mergeDiscoveredModels(
      [{ id: "custom", useRecommendedConfig: false, serviceTiers: ["priority"], maxTokens: 3000 }],
      [{ id: "custom", serviceTiers: [] }],
    )[0],
  ).toMatchObject({ serviceTiers: [], maxTokens: 3000 });
});

it("applies standard explicitly, preserves other request parameters, and never mutates provider models", () => {
  const model = {
    ...fakeModel("https://example.test"),
    serviceTiers: ["priority"],
    samplingParams: { temperature: 0.4, service_tier: "priority" },
  };
  expect(withFastMode(model, true).samplingParams).toEqual({ temperature: 0.4, service_tier: "priority" });
  expect(withFastMode(model).samplingParams).toEqual({ temperature: 0.4, service_tier: "default" });
  expect(model.samplingParams.service_tier).toBe("priority");
  expect(withFastMode({ ...model, serviceTiers: [] }, true).samplingParams).toBe(model.samplingParams);
});

it("persists fast mode per conversation through restart without enabling it in other or new conversations", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  f.settings.saveProvider({
    ...f.settings.snapshot(),
    models: [
      { id: "fake", reasoning: false, serviceTiers: ["priority"] },
      { id: "standard", reasoning: false },
    ],
  });
  const a = await f.host.createSession(f.a.id);
  const b = await f.host.createSession(f.a.id);
  await f.host.setSessionSelection(a.id, {
    provider: "custom",
    modelId: "fake",
    reasoning: "none",
    fastMode: true,
  });
  await f.host.startRun({ sessionId: a.id, text: "fast" });
  await f.host.activeRuns.get(a.id)?.done;
  expect(f.server.requests.at(-1)?.service_tier).toBe("priority");
  expect(f.host.getSessionSnapshot(a.id).controls.selection?.fastMode).toBe(true);
  expect(f.host.getSessionSnapshot(b.id).controls.selection?.fastMode).toBeUndefined();
  const c = await f.host.createSession(f.a.id);
  expect(f.host.getSessionSnapshot(c.id).controls.selection?.fastMode).toBeUndefined();
  await expect(
    f.host.setSessionSelection(a.id, {
      provider: "custom",
      modelId: "standard",
      reasoning: "none",
      fastMode: true,
    }),
  ).rejects.toThrow("不支持加速");
  await f.host.close();
  const settings = new SettingsStore(f.dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  const restored = new SessionHost(f.dir, settings, join(f.dir, "agent"), undefined, undefined);
  cleanup.push(() => restored.close());
  await restored.init();
  expect(restored.getSessionSnapshot(a.id).controls.selection?.fastMode).toBe(true);
  await restored.setSessionSelection(a.id, {
    provider: "custom",
    modelId: "fake",
    reasoning: "none",
    fastMode: false,
  });
  await restored.startRun({ sessionId: a.id, text: "standard" });
  await restored.activeRuns.get(a.id)?.done;
  expect(f.server.requests.at(-1)?.service_tier).toBe("default");
});

it("keeps every tool request in an active run at its original speed after the composer toggle changes", async () => {
  const started = deferred();
  const release = deferred();
  const f = await fixture(async (_, response, index) => {
    if (index === 0) {
      started.resolve();
      await release.promise;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "read",
              type: "function",
              function: { name: "read", arguments: '{"path":"missing.txt"}' },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "ok" }));
      done(response);
    }
  });
  f.settings.saveProvider({
    ...f.settings.snapshot(),
    models: [{ id: "fake", reasoning: false, serviceTiers: ["priority"] }],
  });
  const task = await f.host.createSession(f.a.id);
  await f.host.setSessionSelection(task.id, {
    provider: "custom",
    modelId: "fake",
    reasoning: "none",
    fastMode: true,
  });
  await f.host.startRun({ sessionId: task.id, text: "read" });
  await started.promise;
  await f.host.setSessionSelection(task.id, {
    provider: "custom",
    modelId: "fake",
    reasoning: "none",
    fastMode: false,
  });
  release.resolve();
  await f.host.activeRuns.get(task.id)?.done;
  expect(f.server.requests.map((request) => request.service_tier)).toEqual(["priority", "priority"]);
  await f.host.startRun({ sessionId: task.id, text: "next" });
  await f.host.activeRuns.get(task.id)?.done;
  expect(f.server.requests.at(-1)?.service_tier).toBe("default");
});
