import { emptyAssistant, type ModelPerformanceSample } from "@zpi-dev/ai";
import { afterEach, expect, it, vi } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import {
  modelPerformance,
  performanceScope,
  SessionPerformance,
  validPerformanceTotals,
} from "../src/core/model-performance.ts";

const domestic = {
  ...fakeModel("https://domestic.test/v1"),
  provider: "domestic",
  id: "domestic-chat",
  name: "Domestic",
  reasoning: false,
};
const openai = {
  ...fakeModel("https://api.openai.com/v1"),
  provider: "subscription",
  id: "gpt-6.1-terra",
  name: "Terra",
  api: "openai-responses" as const,
};
const message = (output = 100, reasoning?: number) => {
  const m = emptyAssistant(domestic);
  m.usageAvailable = true;
  Object.assign(m.usage, { output, reasoning, input: 10 });
  return m;
};
const sample = (outputTokens = 100, firstTextMs = 1000, textGenerationMs = 1000): ModelPerformanceSample => ({
  requestMs: firstTextMs + textGenerationMs + 100,
  ttftMs: firstTextMs,
  firstTextMs,
  textGenerationMs,
  outputTokens,
  textChunks: 4,
  textChars: 400,
  largestTextChunk: 100,
});
afterEach(() => vi.useRealTimers());

it("keeps settled readings while streaming and weights qualified samples from the same model", () => {
  const changed = vi.fn();
  const metrics = new SessionPerformance(changed);
  metrics.begin();
  const first = metrics.request(domestic, "off");
  first.update(sample(85, 800, 1000));
  expect(metrics.value).toEqual({});
  expect(changed).not.toHaveBeenCalled();
  first.finish(true, message(85));
  expect(metrics.value).toMatchObject({
    turns: 1,
    steps: 1,
    llmMs: 1900,
    ttftMs: 800,
    requestMs: 1900,
    tokensPerSecond: 85,
    speedSampleCount: 1,
  });
  metrics.settle();
  metrics.begin();
  const next = metrics.request(domestic, "off");
  next.update(sample(115, 1200, 3000));
  expect(metrics.value.tokensPerSecond).toBe(85);
  next.finish(true, message(115));
  next.finish(true, message(115));
  expect(metrics.value).toMatchObject({
    turns: 2,
    steps: 2,
    llmMs: 6200,
    ttftMs: 1200,
    firstTextMs: 1200,
    requestMs: 4300,
    tokensPerSecond: 50,
    speedSampleCount: 2,
  });
  const restored = new SessionPerformance(() => {}, JSON.parse(JSON.stringify(metrics.snapshot)));
  expect(restored.value).toEqual(metrics.value);
});

it.each([
  { textGenerationMs: 0, textChunks: 1 },
  { textGenerationMs: 1, textChunks: 200 },
  { textGenerationMs: 1000, textChunks: 2 },
  { textChars: 1000, largestTextChunk: 990 },
  { requestMs: 50000 },
  { hasToolCalls: true },
  { outputTokens: undefined },
])("omits unreliable delivery speed without hiding counts or timings (%j)", (overrides) => {
  const metrics = new SessionPerformance(() => {});
  metrics.begin();
  const request = metrics.request(openai, "high");
  request.update({ ...sample(538, 20000), ttftMs: 17300, ...overrides });
  request.finish(true, message(538, 530));
  expect(metrics.value).toMatchObject({
    turns: 1,
    steps: 1,
    ttftMs: 17300,
    firstTextMs: 20000,
    speedSampleCount: 0,
    outputTokens: 538,
  });
  expect(metrics.value.tokensPerSecond).toBeUndefined();
  expect(metrics.value.requestTokensPerSecond).toBeUndefined();
});

it("subtracts known reasoning from answer usage, and treats unknown reasoning as unknown", () => {
  const metrics = new SessionPerformance(() => {});
  for (const reasoning of [undefined, 500]) {
    metrics.begin();
    const request = metrics.request(openai, "high");
    request.update({ ...sample(600, 20000), ttftMs: 17000, hasThinking: true });
    request.finish(true, message(600, reasoning));
    expect(metrics.value.requestTokensPerSecond).toBe(reasoning === undefined ? undefined : 100);
  }
  expect(metrics.value).toMatchObject({ turns: 2, steps: 2, tokensPerSecond: 100, speedSampleCount: 1 });
});

it("does not reuse the last speed for a burst from the same model or add it to the average", () => {
  const metrics = new SessionPerformance(() => {});
  for (const textGenerationMs of [1000, 1]) {
    metrics.begin();
    const request = metrics.request(domestic, "off");
    request.update(sample(100, 1000, textGenerationMs));
    request.finish(true, message());
  }
  expect(metrics.value).toMatchObject({ tokensPerSecond: 100, speedSampleCount: 1 });
  expect(metrics.value.requestTokensPerSecond).toBeUndefined();
});

it.each([
  [openai, domestic],
  [domestic, openai],
])(
  "isolates both directions of model switches and restores only matching samples",
  (firstModel, secondModel) => {
    const metrics = new SessionPerformance(() => {});
    for (const [model, tokens] of [
      [firstModel, 100],
      [secondModel, 200],
      [firstModel, 300],
    ] as const) {
      metrics.begin();
      const request = metrics.request(model, "high");
      request.update(sample(tokens));
      request.finish(true, message(tokens, 0));
    }
    const first = modelPerformance(metrics.snapshot, performanceScope(firstModel, "high"));
    const second = modelPerformance(metrics.snapshot, performanceScope(secondModel, "high"));
    expect(first).toMatchObject({
      turns: 3,
      steps: 3,
      outputTokens: 600,
      tokensPerSecond: 200,
      speedSampleCount: 2,
    });
    expect(second).toMatchObject({ tokensPerSecond: 200, speedSampleCount: 1 });
    expect(
      modelPerformance(metrics.snapshot, performanceScope(firstModel, "low")).tokensPerSecond,
    ).toBeUndefined();
    expect(
      modelPerformance(metrics.snapshot, performanceScope({ ...firstModel, provider: "other" }, "high"))
        .ttftMs,
    ).toBeUndefined();
    expect(
      modelPerformance(
        metrics.snapshot,
        performanceScope({ ...firstModel, samplingParams: { service_tier: "priority" } }, "high"),
      ).requestMs,
    ).toBeUndefined();
    expect(modelPerformance(metrics.snapshot, null).modelLabel).toBeUndefined();
    const restored = new SessionPerformance(() => {}, metrics.snapshot);
    expect(restored.value).toEqual(metrics.value);
    const copy = metrics.snapshot;
    if (copy.measurements) Object.values(copy.measurements)[0].sampleCount = 999;
    expect(metrics.value.speedSampleCount).toBe(2);
  },
);

it("counts failed/cancelled steps and billed usage but excludes their timings and late callbacks", () => {
  const metrics = new SessionPerformance(() => {});
  metrics.begin();
  const first = metrics.request(domestic, "off");
  first.update(sample());
  first.finish(true, message());
  const failed = metrics.request(openai, "high");
  failed.update(sample(999, 9000));
  failed.finish(false, message(999));
  metrics.settle();
  metrics.begin();
  const cancelled = metrics.request(openai, "high");
  cancelled.update(sample(9000, 10000));
  metrics.settle();
  cancelled.finish(true, message(9000));
  expect(metrics.value).toMatchObject({
    turns: 1,
    steps: 2,
    ttftMs: 1000,
    tokensPerSecond: 100,
    outputTokens: 1099,
  });
  expect(modelPerformance(metrics.snapshot, performanceScope(openai, "high")).requestMs).toBeUndefined();
});

it("sums parallel tool durations without affecting model delivery speed", () => {
  vi.useFakeTimers();
  const metrics = new SessionPerformance(() => {});
  const first = metrics.request(domestic, "off");
  first.update(sample());
  first.finish(true, message());
  metrics.toolStart("one");
  metrics.toolStart("two");
  vi.advanceTimersByTime(60000);
  metrics.toolEnd("one");
  metrics.toolEnd("two");
  metrics.toolEnd("one");
  expect(metrics.value.toolMs).toBe(120000);
  expect(metrics.value.tokensPerSecond).toBe(100);
});

it("preserves legacy counts and usage without presenting the old mixed-model speed as calibrated", () => {
  const metrics = new SessionPerformance(() => {});
  const m = message(200, 50);
  m.cacheUsageAvailable = true;
  Object.assign(m.usage, { input: 100, cacheRead: 800, cacheWrite: 100 });
  metrics.request().finish(true, m);
  metrics.request().finish(false, m);
  expect(metrics.value).toEqual({
    turns: 1,
    steps: 2,
    inputTokens: 200,
    outputTokens: 400,
    cacheReadTokens: 1600,
    cacheWriteTokens: 200,
    cacheHitRate: 0.8,
  });
  const old = { ...metrics.snapshot, ttftMs: 1000, ttftCount: 1, decodeMs: 1, decodeTokens: 9999 };
  expect(validPerformanceTotals(old)).toBe(true);
  expect(modelPerformance(old)).toEqual(metrics.value);
  expect(validPerformanceTotals({ ...old, steps: -1 })).toBe(false);
  expect(validPerformanceTotals({ ...old, decodeMs: Infinity })).toBe(false);
  expect(validPerformanceTotals({ ...old, measurements: { bad: {} } })).toBe(false);
  expect(validPerformanceTotals({})).toBe(false);
});
