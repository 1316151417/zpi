import { expect, it } from "vitest";
import { emptySession, reduceSession } from "zpi-ui/projection";
import { SettingsStore } from "../src/main/storage.ts";
import { performanceText } from "../src/renderer/ModelPerformance.tsx";
import { cleanup, setup } from "./helpers/session-fixture.ts";

it.each([
  [undefined, ""],
  [{}, ""],
  [{ ttftMs: 0, tokensPerSecond: NaN }, ""],
  [{ ttftMs: -1, tokensPerSecond: Infinity }, ""],
  [{ ttftMs: 800 }, "TTFT 0.8 s"],
  [{ tokensPerSecond: 85 }, "85 tok/s"],
  [{ ttftMs: 800, tokensPerSecond: 85 }, "85 tok/s · TTFT 0.8 s"],
  [{ ttftMs: 1, tokensPerSecond: 0.001 }, "<0.1 tok/s · TTFT <0.1 s"],
] as const)("formats only valid metrics %j", (value, text) => expect(performanceText(value)).toBe(text));

it("isolates task/run updates and clears metrics on the next accepted send", () => {
  let view = emptySession("one");
  const start = { type: "started" as const, text: "go", startedAt: 1, modelLabel: "fake" };
  view = reduceSession(view, { sessionId: "one", runId: "r1", seq: 1, event: start });
  const event = { type: "model_performance" as const, performance: { ttftMs: 800, tokensPerSecond: 85 } };
  view = reduceSession(view, { sessionId: "one", runId: "r1", seq: 2, event });
  expect(reduceSession(view, { sessionId: "two", runId: "r1", seq: 100, event })).toBe(view);
  view = reduceSession(view, { sessionId: "one", runId: "r2", seq: 3, event: start });
  expect(view.modelPerformance).toBeUndefined();
  view = reduceSession(view, { sessionId: "one", runId: "r1", seq: 4, event });
  expect(view.modelPerformance).toBeUndefined();
});

it("defaults old settings to off, validates and persists the preference", async () => {
  const { dir, settings } = await setup();
  const saved = settings.state.getSetting<{ interface: Record<string, unknown> }>("app");
  if (!saved) throw new Error("Missing settings");
  delete saved.interface.showModelPerformance;
  settings.state.setSetting("app", saved);
  const reopened = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  cleanup.push(async () => reopened.close());
  expect(reopened.get().interface.showModelPerformance).toBe(false);
  expect(() => reopened.updatePreferences({ showModelPerformance: "yes" as unknown as boolean })).toThrow();
  reopened.updatePreferences({ showModelPerformance: true });
  const restored = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  cleanup.push(async () => restored.close());
  expect(restored.get().interface.showModelPerformance).toBe(true);
});
