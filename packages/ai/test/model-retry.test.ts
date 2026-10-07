import type { ModelRetryStatus } from "ZPI-ai";
import { createAssistantMessageEventStream, emptyAssistant, normalizeContext, streamSimple } from "ZPI-ai";
import { afterEach, expect, it, vi } from "vitest";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";
import {
  modelFailure,
  modelRetryDelay,
  retryModelStream,
  sleepForModelRetry,
} from "../src/utils/model-retry.ts";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const httpError = (status: number, code?: string, headers: Record<string, string> = {}) =>
  Object.assign(new Error("provider unavailable"), {
    status,
    error: { code },
    headers: new Headers(headers),
  });

it("retries an empty completion once and fails if the second completion is also empty", async () => {
  vi.useFakeTimers();
  const output = emptyAssistant(fakeModel(""));
  const consume = vi.fn(async (sink: { push: (event: import("ZPI-ai").AssistantMessageEvent) => void }) => {
    sink.push({ type: "done", reason: "stop", message: output });
  });
  const run = retryModelStream(consume, createAssistantMessageEventStream(), {});
  const failed = expect(run).rejects.toThrow("no text, no tool calls, and no usage");
  await vi.runAllTimersAsync();
  await failed;
  expect(consume).toHaveBeenCalledTimes(2);
});

it("uses ZCode backoff, jitter, server delays and terminal business codes", () => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
  expect([1, 2, 3, 4, 5, 6, 10].map((n) => modelRetryDelay(n))).toEqual([
    1500, 3000, 6000, 12000, 24000, 45000, 45000,
  ]);
  expect(modelRetryDelay(1, 120_000)).toBe(120_000);
  expect(modelRetryDelay(1, 300_001)).toBe(1500);
  expect(modelRetryDelay(10, 400_000)).toBe(400_000);
  expect(modelFailure(httpError(429, undefined, { "retry-after-ms": "120000", "retry-after": "1" }))).toEqual(
    { retryable: true, status: 429, retryAfterMs: 120_000 },
  );
  expect(
    modelFailure(httpError(429, undefined, { "x-should-retry": "false", "retry-after": "120" })),
  ).toEqual({ retryable: true, status: 429 });
  for (const code of ["insufficient_quota", "1308", "3010", "1261"])
    expect(modelFailure(httpError(429, code)).retryable).toBe(false);
  for (const status of [400, 401, 403, 404, 422])
    expect(modelFailure(httpError(status)).retryable).toBe(false);
  for (const status of [408, 429, 500, 503, 529])
    expect(modelFailure(httpError(status)).retryable).toBe(true);
  expect(modelFailure({ cause: { code: "ECONNRESET" } }).retryable).toBe(true);
  expect(
    modelFailure({ error: { type: "api_error", message: "500 Internal network error" } }).retryable,
  ).toBe(true);
  expect(modelFailure({ cause: { code: "CERT_HAS_EXPIRED" } }).retryable).toBe(false);
});

it("makes eleven attempts, publishes retry counts, and aborts long server waits immediately", async () => {
  vi.useFakeTimers();
  const events = createAssistantMessageEventStream();
  const states: (ModelRetryStatus | null)[] = [];
  const consume = vi.fn().mockRejectedValue(httpError(429, undefined, { "retry-after": "0" }));
  const run = retryModelStream(consume, events, { onRetry: (s) => states.push(s) });
  const failed = expect(run).rejects.toThrow("provider unavailable");
  await vi.runAllTimersAsync();
  await failed;
  expect(consume).toHaveBeenCalledTimes(11);
  expect(states.filter((s) => s !== null).map((s) => s.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  expect(states.at(-1)).toBeNull();
  const controller = new AbortController();
  const waiting = sleepForModelRetry(120_000, controller.signal);
  const stopped = expect(waiting).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await stopped;
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["openai-completions", "openai-responses"] as const)(
  "retries HTTP failures through %s without duplicating a reply",
  async (api) => {
    const states: (ModelRetryStatus | null)[] = [];
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      if (++attempts <= 3)
        return new Response('{"error":{"message":"busy"}}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      const data =
        api === "openai-completions"
          ? [chunk({ content: "recovered" }), chunk({}, "stop")]
          : [
              { type: "response.output_text.delta", item_id: "m", content_index: 0, delta: "recovered" },
              {
                type: "response.completed",
                response: { id: "r", status: "completed", output: [], usage: null },
              },
            ];
      return new Response(data.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const stream = streamSimple(
      { ...fakeModel("http://local/v1"), api },
      normalizeContext({ messages: [] }),
      { apiKey: "local", fetch: fetcher, onRetry: (s) => states.push(s) },
    );
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "recovered" }]);
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(states.filter(Boolean)).toMatchObject([
      { attempt: 1, maxRetries: 10 },
      { attempt: 2 },
      { attempt: 3 },
    ]);
  },
);

it("discards incomplete tool preludes before retry but never replays a visible token", async () => {
  const events = createAssistantMessageEventStream();
  const output = emptyAssistant(fakeModel(""));
  let attempt = 0;
  await retryModelStream(
    async (sink) => {
      sink.push({ type: "start", partial: output });
      if (++attempt === 1) {
        sink.push({ type: "toolcall_delta", contentIndex: 0, delta: "partial", partial: output });
        throw httpError(503, undefined, { "retry-after": "0" });
      }
      sink.push({ type: "text_delta", contentIndex: 0, delta: "final", partial: output });
      sink.push({
        type: "done",
        reason: "stop",
        message: { ...output, content: [{ type: "text", text: "final" }] },
      });
    },
    events,
    {},
  ).then(() => {});
  const seen: string[] = [];
  for await (const event of events) seen.push(event.type);
  expect(seen).toEqual(["start", "text_delta", "done"]);
  const partial = vi.fn(async (sink: { push: (event: import("ZPI-ai").AssistantMessageEvent) => void }) => {
    sink.push({ type: "text_delta", contentIndex: 0, delta: "visible", partial: output });
    throw httpError(503);
  });
  await expect(retryModelStream(partial, createAssistantMessageEventStream(), {})).rejects.toThrow();
  expect(partial).toHaveBeenCalledTimes(1);
});
