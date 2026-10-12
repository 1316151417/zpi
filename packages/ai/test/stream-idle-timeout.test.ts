import { afterEach, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  emptyAssistant,
  guardModelStream,
  normalizeContext,
  streamSimple,
} from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import {
  closeStreamIterator,
  createLinkedAbortController,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "../src/utils/stream-idle-timeout.ts";

// Parity vectors from ZCode 872ad960 stream-idle-timeout.ts and runner-stream.ts.
afterEach(() => vi.useRealTimers());

it.each([
  [{}, 600_000],
  [{ retryNumber: 1 }, 630_000],
  [{ retryNumber: 10 }, 900_000],
  [{ baseTimeoutMs: 500, retryNumber: 2.9 }, 60_500],
  [{ baseTimeoutMs: 0, retryNumber: 10 }, 0],
  [{ baseTimeoutMs: -1, retryNumber: 10 }, -1],
  [{ baseTimeoutMs: NaN, retryNumber: Infinity }, 600_000],
  [{ retryNumber: -2 }, 600_000],
])("matches ZCode's idle window resolution: %j", (options, expected) => {
  expect(resolveModelStreamIdleTimeoutMs(options)).toBe(expected);
});

it("aborts a stalled next() even when the iterator ignores cancellation, preserving the timeout reason", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const onTimeout = vi.fn();
  const waiting = readNextWithStreamIdleTimeout(
    { next: () => new Promise<never>(() => {}) },
    {
      abortController: controller,
      timeoutMs: 600_000,
      onTimeout,
    },
  );
  const outcome = waiting.catch((error) => error);
  await vi.advanceTimersByTimeAsync(599_999);
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(await outcome).toMatchObject({
    name: "ModelStreamIdleTimeoutError",
    code: "MODEL_STREAM_IDLE_TIMEOUT",
    idleMs: 600_000,
    timeoutMs: 600_000,
  });
  expect(controller.signal.reason).toBe(await outcome);
  expect(onTimeout).toHaveBeenCalledExactlyOnceWith(await outcome);
  expect(vi.getTimerCount()).toBe(0);
});

it("gives each next() a new window, rather than timing the whole response", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const read = () =>
    readNextWithStreamIdleTimeout(
      {
        next: () =>
          new Promise<IteratorResult<number>>((resolve) =>
            setTimeout(() => resolve({ done: false, value: 1 }), 90),
          ),
      },
      { abortController: controller, timeoutMs: 100 },
    );
  for (let i = 0; i < 5; i++) {
    const next = read();
    await vi.advanceTimersByTimeAsync(90);
    expect(await next).toEqual({ done: false, value: 1 });
  }
  expect(controller.signal.aborted).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

it("propagates caller cancellation without waiting for the idle deadline or reporting a stall", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const linked = createLinkedAbortController(parent.signal);
  const onTimeout = vi.fn();
  const next = readNextWithStreamIdleTimeout(
    { next: () => new Promise<never>(() => {}) },
    {
      abortController: linked.controller,
      timeoutMs: 600_000,
      onTimeout,
    },
  ).catch((error) => error);
  const reason = new Error("user stopped");
  parent.abort(reason);
  expect(await next).toBe(reason);
  expect(onTimeout).not.toHaveBeenCalled();
  linked.cleanup();
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds iterator cleanup at exactly one second and swallows cleanup failures", async () => {
  vi.useFakeTimers();
  let finished = false;
  const closing = closeStreamIterator({
    next: () => new Promise(() => {}),
    return: () => new Promise(() => {}),
  }).then(() => {
    finished = true;
  });
  await vi.advanceTimersByTimeAsync(999);
  expect(finished).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await closing;
  await closeStreamIterator({
    next: async () => ({ done: true, value: undefined }),
    return: async () => {
      throw new Error("cleanup");
    },
  });
  expect(vi.getTimerCount()).toBe(0);
});

it("retains only closed tool calls on timeout and isolates late provider output", async () => {
  vi.useFakeTimers();
  const model = fakeModel("");
  const source = createAssistantMessageEventStream();
  const partial = emptyAssistant(model);
  const closed = { type: "toolCall" as const, id: "closed", name: "read", arguments: { path: "a" } };
  partial.content = [closed, { ...closed, id: "incomplete" }];
  source.push({ type: "start", partial });
  source.push({ type: "toolcall_end", contentIndex: 0, toolCall: closed, partial });
  let child: AbortSignal | undefined;
  const output = guardModelStream(
    model,
    (options) => {
      child = options.signal;
      return source;
    },
    { streamIdleTimeoutMs: 100 },
  );
  await vi.advanceTimersByTimeAsync(1_100);
  const failure = await output.result();
  expect(child?.aborted).toBe(true);
  expect(failure).toMatchObject({
    stopReason: "error",
    errorDetails: { retryable: true, code: "MODEL_STREAM_IDLE_TIMEOUT", timeoutMs: 100, idleMs: 100 },
    content: [closed],
  });
  partial.content = [{ type: "text", text: "late answer" }];
  source.end(partial);
  await vi.advanceTimersByTimeAsync(0);
  expect((await output.result()).content).toEqual([closed]);
  expect(vi.getTimerCount()).toBe(0);
});

it.each(["openai-responses", "openai-completions", "anthropic-messages"] as const)(
  "does not let SSE heartbeat bytes keep a stalled %s model alive",
  async (api) => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let bytes!: ReadableStreamDefaultController<Uint8Array>;
    let requestSignal: AbortSignal | undefined;
    const output = streamSimple(
      { ...fakeModel("https://example.test"), api },
      normalizeContext({ messages: [] }),
      {
        apiKey: "test",
        streamIdleTimeoutMs: 100,
        maxRetries: 0,
        fetch: async (_url, init) => {
          requestSignal = init?.signal ?? undefined;
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                bytes = controller;
              },
            }),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      },
    );
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < 4; i++) {
      bytes.enqueue(encoder.encode(": keepalive\n\n"));
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_020);
    expect(await output.result()).toMatchObject({
      stopReason: "error",
      errorDetails: { retryable: true, code: "MODEL_STREAM_IDLE_TIMEOUT", timeoutMs: 100 },
    });
    expect(requestSignal?.aborted).toBe(true);
    bytes.error(new Error("test cleanup"));
    await vi.advanceTimersByTimeAsync(0);
  },
);

it("covers a request that never returns headers and an unresponsive credential lookup", async () => {
  vi.useFakeTimers();
  const model = fakeModel("https://example.test");
  for (const options of [
    { apiKey: "test", fetch: (() => new Promise(() => {})) as typeof fetch },
    { getApiKey: () => new Promise<string>(() => {}) },
  ]) {
    const output = streamSimple(model, normalizeContext({ messages: [] }), {
      ...options,
      streamIdleTimeoutMs: 100,
    });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await output.result()).toMatchObject({
      stopReason: "error",
      errorDetails: { retryable: true, code: "MODEL_STREAM_IDLE_TIMEOUT" },
    });
  }
});

it("disables the event deadline when configured to zero and never starts an already-cancelled request", async () => {
  vi.useFakeTimers();
  const model = fakeModel("");
  const source = createAssistantMessageEventStream();
  const output = guardModelStream(model, () => source, { streamIdleTimeoutMs: 0 });
  await vi.advanceTimersByTimeAsync(900_000);
  expect(vi.getTimerCount()).toBe(0);
  source.end(emptyAssistant(model));
  expect((await output.result()).stopReason).toBe("stop");
  const create = vi.fn(() => source);
  const cancelled = guardModelStream(model, create, { signal: AbortSignal.abort() });
  expect((await cancelled.result()).stopReason).toBe("aborted");
  expect(create).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps stop distinct from timeout when a provider never responds to abort", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const source = createAssistantMessageEventStream();
  const output = guardModelStream(fakeModel(""), () => source, { signal: parent.signal });
  parent.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await output.result()).toMatchObject({ stopReason: "aborted", errorDetails: { retryable: false } });
  expect(vi.getTimerCount()).toBe(0);
});
