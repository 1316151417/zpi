import { join } from "node:path";
import { expect, it } from "vitest";
import { emptySession, reduceSession } from "zpi-ui/projection";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import {
  formatCacheRate,
  formatDuration,
  formatSpeed,
  formatTokens,
} from "../src/renderer/ModelPerformance.tsx";
import { cleanup, setup } from "./helpers/session-fixture.ts";

it("matches the Harness numeric formats without rounding a partial cache hit to 100%", () => {
  expect(formatSpeed(85.2)).toBe("85 tok/s");
  expect(formatSpeed(8.12)).toBe("8.1 tok/s");
  expect(formatDuration(800)).toBe("0.8秒");
  expect(formatDuration(162000)).toBe("2分42秒");
  expect(formatTokens(12200)).toBe("12.2K");
  expect(formatTokens(1200000)).toBe("1.2M");
  expect(formatCacheRate(0)).toBe("0%");
  expect(formatCacheRate(0.9996)).toBe("99.96%");
  expect(formatCacheRate(1)).toBe("100%");
});

it("isolates task/run updates and retains metrics on the next accepted send", () => {
  let view = emptySession("one");
  const start = { type: "started" as const, text: "go", startedAt: 1, modelLabel: "fake" };
  view = reduceSession(view, { sessionId: "one", runId: "r1", seq: 1, event: start });
  const event = { type: "model_performance" as const, performance: { ttftMs: 800, tokensPerSecond: 85 } };
  view = reduceSession(view, { sessionId: "one", runId: "r1", seq: 2, event });
  expect(reduceSession(view, { sessionId: "two", runId: "r1", seq: 100, event })).toBe(view);
  view = reduceSession(view, { sessionId: "one", runId: "r2", seq: 3, event: start });
  expect(view.modelPerformance).toEqual(event.performance);
  view = reduceSession(view, { sessionId: "one", runId: "r1", seq: 4, event });
  expect(view.modelPerformance).toEqual(event.performance);
});

it("defaults new and old settings to on, validates and preserves an explicit opt-out", async () => {
  const { dir, settings } = await setup();
  expect(settings.get().interface.showModelPerformance).toBe(true);
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
  expect(reopened.get().interface.showModelPerformance).toBe(true);
  expect(() => reopened.updatePreferences({ showModelPerformance: "yes" as unknown as boolean })).toThrow();
  reopened.updatePreferences({ showModelPerformance: false });
  const restored = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  cleanup.push(async () => restored.close());
  expect(restored.get().interface.showModelPerformance).toBe(false);
});

it("backfills historical counts on upgrade and continues accumulating after restart", async () => {
  const { dir, cwd, host, settings } = await setup();
  const task = await host.createSession(null, { cwd });
  await host.startRun({ sessionId: task.id, text: "first" });
  await host.activeRuns.get(task.id)?.done;
  const first = host.getSessionSnapshot(task.id).view.modelPerformance;
  expect(first).toMatchObject({ turns: 1, steps: 1 });
  await host.close();
  // Upgrading from a version without persisted totals recovers counts from history, not invented timings.
  const saved = settings.state.getTask(task.id);
  if (!saved) throw new Error("Missing task");
  settings.state.upsertTask({ ...saved, modelPerformanceTotals: undefined });
  const reopened = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined);
  cleanup.push(() => reopened.close());
  await reopened.init();
  expect(reopened.getSessionSnapshot(task.id).view.modelPerformance).toEqual({ turns: 1, steps: 1 });
  await reopened.startRun({ sessionId: task.id, text: "second" });
  expect(reopened.getSessionSnapshot(task.id).view.modelPerformance).toEqual({ turns: 1, steps: 1 });
  await reopened.activeRuns.get(task.id)?.done;
  expect(reopened.getSessionSnapshot(task.id).view.modelPerformance).toMatchObject({ turns: 2, steps: 2 });
});
