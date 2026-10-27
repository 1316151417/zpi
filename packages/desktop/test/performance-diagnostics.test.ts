import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import type { ErrorLog } from "../src/main/error-log.ts";
import {
  startMainPerformanceDiagnostics,
  trackRendererResponsiveness,
} from "../src/main/performance-diagnostics.ts";
import {
  recordEventBatch,
  startRendererPerformanceDiagnostics,
} from "../src/renderer/performance-diagnostics.ts";
import { performanceReportIntervalMs, SlowOperations } from "../src/shared/performance-diagnostics.ts";

const stops: (() => void)[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("retains only fixed-size summaries of slow work and excludes ordinary and invalid samples", () => {
  const samples = new SlowOperations();
  for (const duration of [0, 49, -1, Number.NaN, Number.POSITIVE_INFINITY])
    samples.record("event-batch", duration, 100);
  expect(samples.drain()).toEqual([]);
  for (let i = 0; i < 10_000; i++) samples.record("event-batch", 50.1, 2);
  samples.record("long-task", 70_000);
  expect(samples.drain()).toEqual([
    { operation: "event-batch", count: 10_000, maxMs: 50, totalMs: 501_000, eventCount: 20_000 },
    { operation: "long-task", count: 1, maxMs: 70_000, totalMs: 70_000, eventCount: 0 },
  ]);
  expect(samples.drain()).toEqual([]);
});

function renderer() {
  vi.useFakeTimers();
  const logError = vi.fn();
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  vi.stubGlobal("document", document);
  vi.stubGlobal("window", { zpi: { logError } });
  let publish!: (entries: Partial<PerformanceEntry>[]) => void;
  const disconnect = vi.fn();
  class Observer {
    static supportedEntryTypes = ["longtask"];
    constructor(callback: PerformanceObserverCallback) {
      publish = (entries) =>
        callback(
          { getEntries: () => entries } as PerformanceObserverEntryList,
          this as unknown as PerformanceObserver,
        );
    }
    observe() {}
    disconnect = disconnect;
  }
  vi.stubGlobal("PerformanceObserver", Observer);
  return {
    document,
    logError,
    disconnect,
    publish: (entries: Partial<PerformanceEntry>[]) => publish(entries),
  };
}

it("reports slow visible tasks and event batches once per interval, without content or stacks", () => {
  const f = renderer();
  const stop = startRendererPerformanceDiagnostics();
  stops.push(stop);
  f.publish([
    { startTime: 1, duration: 199 },
    { startTime: 2, duration: 250 },
  ]);
  for (let i = 0; i < 100; i++) recordEventBatch(75, 20);
  expect(f.logError).not.toHaveBeenCalled();
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(
    f.logError.mock.calls.map(([entry]) => ({ source: entry.source, ...JSON.parse(entry.message) })),
  ).toEqual([
    { source: "performance", operation: "long-task", count: 1, maxMs: 250, totalMs: 250, eventCount: 0 },
    {
      source: "performance",
      operation: "event-batch",
      count: 100,
      maxMs: 75,
      totalMs: 7500,
      eventCount: 2000,
    },
  ]);
  vi.advanceTimersByTime(performanceReportIntervalMs * 3);
  expect(f.logError).toHaveBeenCalledTimes(2);
  stop();
  stops.pop();
  recordEventBatch(100, 50);
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(f.disconnect).toHaveBeenCalledOnce();
  expect(f.logError).toHaveBeenCalledTimes(2);
});

it("preserves visible samples while ignoring hidden work and stale entries after becoming visible", () => {
  const f = renderer();
  stops.push(startRendererPerformanceDiagnostics());
  recordEventBatch(100, 10);
  f.document.visibilityState = "hidden";
  f.document.dispatchEvent(new Event("visibilitychange"));
  recordEventBatch(100, 10);
  f.publish([{ startTime: 1, duration: 500 }]);
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(f.logError).toHaveBeenCalledOnce();
  expect(JSON.parse(f.logError.mock.calls[0][0].message)).toMatchObject({
    operation: "event-batch",
    count: 1,
    eventCount: 10,
  });
  f.document.visibilityState = "visible";
  f.document.dispatchEvent(new Event("visibilitychange"));
  f.publish([{ startTime: 1, duration: 500 }]);
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(f.logError).toHaveBeenCalledOnce();
});

it("keeps event-batch diagnostics available when long-task observation is unsupported or fails", () => {
  const f = renderer();
  vi.stubGlobal(
    "PerformanceObserver",
    class {
      static supportedEntryTypes = ["longtask"];
      observe() {
        throw new Error("unsupported");
      }
      disconnect() {}
    },
  );
  const stop = startRendererPerformanceDiagnostics();
  stops.push(stop);
  recordEventBatch(60, 3);
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(f.logError).toHaveBeenCalledOnce();
  stop();
  stops.pop();
  vi.stubGlobal("PerformanceObserver", undefined);
  stops.push(startRendererPerformanceDiagnostics());
  recordEventBatch(60, 3);
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(f.logError).toHaveBeenCalledTimes(2);
});

it("summarizes main-loop stalls, ignores suspend gaps, and stops its timer", () => {
  vi.useFakeTimers();
  const write = vi.fn();
  let now = 0;
  const monitor = startMainPerformanceDiagnostics({ write } as unknown as ErrorLog, () => now);
  stops.push(monitor.stop);
  now = 1_300;
  vi.advanceTimersByTime(1_000);
  expect(write).not.toHaveBeenCalled();
  for (let i = 0; i < 9; i++) {
    now += 1_000;
    vi.advanceTimersByTime(1_000);
  }
  expect(write).toHaveBeenCalledExactlyOnceWith("main.performance", "Slow event loop", {
    operation: "main-loop",
    count: 1,
    maxMs: 300,
    totalMs: 300,
    eventCount: 0,
  });
  monitor.suspend();
  now += 120_000;
  vi.advanceTimersByTime(1_000);
  monitor.resume();
  now += 1_000;
  vi.advanceTimersByTime(1_000);
  expect(write).toHaveBeenCalledOnce();
  // A real long stall must not be mistaken for sleep just because of its duration.
  now += 71_000;
  vi.advanceTimersByTime(1_000);
  expect(write).toHaveBeenLastCalledWith("main.performance", "Slow event loop", {
    operation: "main-loop",
    count: 1,
    maxMs: 70_000,
    totalMs: 70_000,
    eventCount: 0,
  });
  monitor.stop();
  stops.pop();
  now += 5_000;
  vi.advanceTimersByTime(performanceReportIntervalMs);
  expect(write).toHaveBeenCalledTimes(2);
});

it("records one unresponsive incident and the matching recovery duration", () => {
  const write = vi.fn();
  const contents = Object.assign(new EventEmitter(), { id: 4 });
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  trackRendererResponsiveness(contents as unknown as WebContents, { write } as unknown as ErrorLog);
  contents.emit("responsive");
  contents.emit("unresponsive");
  contents.emit("unresponsive");
  now.mockReturnValue(1_600);
  contents.emit("responsive");
  expect(write.mock.calls).toEqual([
    ["renderer.unresponsive", "Renderer stopped responding", { webContentsId: 4 }],
    ["renderer.responsive", "Renderer recovered", { webContentsId: 4, durationMs: 1500 }],
  ]);
});
