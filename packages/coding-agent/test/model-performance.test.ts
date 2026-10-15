import { afterEach, expect, it, vi } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { SessionPerformance, validPerformanceTotals } from "../src/core/model-performance.ts";

afterEach(() => vi.useRealTimers());

it("keeps readings while streaming and accumulates requests across turns with weighted speed", () => {
  const changed = vi.fn();
  const metrics = new SessionPerformance(changed);
  metrics.begin();
  const first = metrics.request();
  first.update({ ttftMs: 800, outputTokens: 85, generationMs: 900, requestMs: 1800 });
  expect(metrics.value).toEqual({});
  expect(changed).not.toHaveBeenCalled();
  first.finish(true);
  expect(metrics.value).toEqual({ turns: 1, steps: 1, llmMs: 1800, ttftMs: 800, tokensPerSecond: 85 });
  metrics.settle();
  metrics.begin();
  expect(metrics.value.tokensPerSecond).toBe(85);
  const next = metrics.request();
  next.update({ ttftMs: 1200, outputTokens: 115, generationMs: 2000, requestMs: 4200 });
  expect(metrics.value.tokensPerSecond).toBe(85);
  next.finish(true);
  next.finish(true); // A terminal event plus finally cannot count twice.
  expect(metrics.value).toEqual({ turns: 2, steps: 2, llmMs: 6000, ttftMs: 1000, tokensPerSecond: 50 });
  const restored = new SessionPerformance(() => {}, JSON.parse(JSON.stringify(metrics.snapshot)));
  expect(restored.value).toEqual(metrics.value);
});

it("counts closed failed/cancelled steps but excludes their timings, invalidates late callbacks", () => {
  const metrics = new SessionPerformance(() => {});
  metrics.begin();
  const first = metrics.request();
  first.update({ ttftMs: 800 });
  first.finish(true);
  const failed = metrics.request();
  failed.update({ ttftMs: 9000, outputTokens: 999, generationMs: 1 });
  failed.finish(false);
  const retried = metrics.request();
  retried.update({ ttftMs: 1200, outputTokens: 200, generationMs: 4000 });
  retried.finish(true);
  metrics.settle();
  metrics.begin();
  const cancelled = metrics.request();
  cancelled.update({ ttftMs: 10000 });
  cancelled.finish(false);
  metrics.settle();
  cancelled.update({ ttftMs: 99999 });
  cancelled.finish(true);
  expect(metrics.value).toEqual({ turns: 2, steps: 4, ttftMs: 1000, tokensPerSecond: 50 });
});

it("sums parallel tool durations separately without lowering model speed", () => {
  vi.useFakeTimers();
  const metrics = new SessionPerformance(() => {});
  const first = metrics.request();
  first.update({ ttftMs: 1000, outputTokens: 100, generationMs: 1000 });
  first.finish(true);
  metrics.toolStart("one");
  metrics.toolStart("two");
  vi.advanceTimersByTime(60_000);
  metrics.toolEnd("one");
  metrics.toolEnd("two");
  metrics.toolEnd("one");
  expect(metrics.value.toolMs).toBe(120000);
  expect(metrics.value.tokensPerSecond).toBe(100);
});

it("sums provider billing buckets including failed billed attempts without double-counting reasoning", () => {
  const metrics = new SessionPerformance(() => {});
  const message = emptyAssistant(fakeModel(""));
  message.usageAvailable = true;
  message.cacheUsageAvailable = true;
  Object.assign(message.usage, { input: 100, cacheRead: 800, cacheWrite: 100, output: 200, reasoning: 50 });
  metrics.request().finish(true, message);
  metrics.request().finish(false, message);
  expect(metrics.value).toEqual({
    turns: 1,
    steps: 2,
    inputTokens: 200,
    outputTokens: 400,
    cacheReadTokens: 1600,
    cacheWriteTokens: 200,
    cacheHitRate: 0.8,
  });
  expect(validPerformanceTotals(metrics.snapshot)).toBe(true);
  expect(validPerformanceTotals({ ...metrics.snapshot, steps: -1 })).toBe(false);
  expect(validPerformanceTotals({ ...metrics.snapshot, decodeMs: Infinity })).toBe(false);
  expect(validPerformanceTotals({})).toBe(false);
});
