import { afterEach, expect, it, vi } from "vitest";
import { InteractionPerformance } from "../src/core/model-performance.ts";

afterEach(() => vi.useRealTimers());

it("averages TTFT arithmetically and weights speed by generation time across tool waits", () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const metrics = new InteractionPerformance(changed);
  metrics.reset();
  const first = metrics.request();
  first.update({ ttftMs: 800, outputTokens: 85, generationMs: 1000 });
  first.finish(true);
  expect(metrics.value).toEqual({ ttftMs: 800, tokensPerSecond: 85 });
  vi.advanceTimersByTime(60_000); // Tool execution, no requests running.
  expect(metrics.value).toEqual({ ttftMs: 800, tokensPerSecond: 85 });
  const second = metrics.request();
  second.update({ ttftMs: 1200, outputTokens: 115, generationMs: 3000 });
  second.finish(true);
  metrics.settle();
  expect(changed.mock.lastCall).toEqual([{ ttftMs: 1000, tokensPerSecond: 50 }]);
});

it("throttles live updates to 750 ms and immediately flushes final results", () => {
  vi.useFakeTimers();
  const changed = vi.fn();
  const metrics = new InteractionPerformance(changed);
  metrics.reset();
  const request = metrics.request();
  request.update({ ttftMs: 800 });
  vi.advanceTimersByTime(749);
  expect(changed).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(1);
  expect(changed.mock.lastCall).toEqual([{ ttftMs: 800 }]);
  for (let i = 0; i < 100; i++) request.update({ ttftMs: 800, outputTokens: i, generationMs: 1000 });
  expect(changed).toHaveBeenCalledTimes(2);
  request.finish(true);
  expect(changed.mock.lastCall).toEqual([{ ttftMs: 800, tokensPerSecond: 99 }]);
  vi.advanceTimersByTime(1000);
  expect(changed).toHaveBeenCalledTimes(3);
});

it("removes failed/cancelled provisional requests, excludes missing usage and resets the next interaction", () => {
  const metrics = new InteractionPerformance(() => {});
  const first = metrics.request();
  first.update({ ttftMs: 800 });
  first.finish(true);
  const failure = metrics.request();
  failure.update({ ttftMs: 9000, outputTokens: 1000, generationMs: 500 });
  failure.finish(false);
  expect(metrics.value).toEqual({ ttftMs: 800 });
  const retried = metrics.request();
  retried.update({ ttftMs: 1200, outputTokens: 200, generationMs: 4000 });
  retried.finish(true);
  expect(metrics.value).toEqual({ ttftMs: 1000, tokensPerSecond: 50 });
  const cancelled = metrics.request();
  cancelled.update({ ttftMs: 10000, outputTokens: 5, generationMs: 1 });
  metrics.settle();
  expect(metrics.value).toEqual({ ttftMs: 1000, tokensPerSecond: 50 });
  metrics.reset();
  cancelled.update({ ttftMs: 999 });
  cancelled.finish(true);
  expect(metrics.value).toEqual({});
});
