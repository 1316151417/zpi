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

afterEach(() => vi.useRealTimers());

it.each([
  [{}, 300_000],
  [{ retryNumber: 1 }, 300_000],
  [{ retryNumber: 10 }, 300_000],
  [{ baseTimeoutMs: 500, retryNumber: 2.9 }, 500],
  [{ baseTimeoutMs: 0, retryNumber: 10 }, 0],
  [{ baseTimeoutMs: -1, retryNumber: 10 }, -1],
  [{ baseTimeoutMs: NaN, retryNumber: Infinity }, 300_000],
  [{ retryNumber: -2 }, 300_000],
])("keeps the idle window fixed across retries: %j", (options, expected) => {
  expect(resolveModelStreamIdleTimeoutMs(options)).toBe(expected);
});

it("uses the first-response deadline through empty starts, then the idle deadline after output", async () => {
  vi.useFakeTimers();
  const model = fakeModel("");
  for (const emitsText of [false, true]) {
    const source = createAssistantMessageEventStream();
    const partial = emptyAssistant(model);
    const output = guardModelStream(model, () => source, {
      streamFirstResponseTimeoutMs: 100,
      streamIdleTimeoutMs: 300,
    });
    await vi.advanceTimersByTimeAsync(50);
    source.push({ type: "start", partial });
    if (emitsText) {
      partial.content = [{ type: "text", text: "x" }];
      source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
    }
    await vi.advanceTimersByTimeAsync(emitsText ? 1_300 : 1_050);
    expect(await output.result()).toMatchObject({
      errorDetails: { code: "MODEL_STREAM_IDLE_TIMEOUT", timeoutMs: emitsText ? 300 : 100 },
    });
    source.end(partial);
  }
});

it("reports waiting only after 15 seconds and clears it on output and cancellation", async () => {
  vi.useFakeTimers();
  const model = fakeModel("");
  const source = createAssistantMessageEventStream();
  const partial = emptyAssistant(model);
  const parent = new AbortController();
  const onModelWait = vi.fn();
  const output = guardModelStream(model, () => source, { signal: parent.signal, onModelWait });
  await vi.advanceTimersByTimeAsync(14_999);
  expect(onModelWait).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onModelWait).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "first_response" }));
  partial.content = [{ type: "text", text: "x" }];
  source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
  await vi.advanceTimersByTimeAsync(0);
  expect(onModelWait).toHaveBeenLastCalledWith(null);
  await vi.advanceTimersByTimeAsync(15_000);
  expect(onModelWait).toHaveBeenLastCalledWith(expect.objectContaining({ phase: "stream" }));
  parent.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await output.result()).stopReason).toBe("aborted");
  expect(onModelWait).toHaveBeenLastCalledWith(null);
  expect(vi.getTimerCount()).toBe(0);
  source.end(partial);
});

it("reports waiting fifteen seconds after the latest output in a continuous stream", async () => {
  vi.useFakeTimers();
  const model = fakeModel("");
  const source = createAssistantMessageEventStream();
  const partial = emptyAssistant(model);
  const parent = new AbortController();
  const onModelWait = vi.fn();
  const output = guardModelStream(model, () => source, { signal: parent.signal, onModelWait });
  for (let index = 0; index < 3; index++) {
    await vi.advanceTimersByTimeAsync(10_000);
    source.push({ type: "text_delta", contentIndex: 0, delta: "x", partial });
    await vi.advanceTimersByTimeAsync(0);
    expect(onModelWait).not.toHaveBeenCalled();
  }
  const startedAt = Date.now();
  await vi.advanceTimersByTimeAsync(14_999);
  expect(onModelWait).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(onModelWait).toHaveBeenCalledExactlyOnceWith({ phase: "stream", startedAt });
  parent.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  expect((await output.result()).stopReason).toBe("aborted");
  expect(onModelWait).toHaveBeenLastCalledWith(null);
  expect(vi.getTimerCount()).toBe(0);
  source.end(partial);
});

it.each([false, true])(
  "empty content blocks neither extend the deadline nor clear waiting (streaming=%s)",
  async (streaming) => {
    vi.useFakeTimers();
    const model = fakeModel("");
    const source = createAssistantMessageEventStream();
    const partial = emptyAssistant(model);
    const onModelWait = vi.fn();
    let requestSignal: AbortSignal | undefined;
    const output = guardModelStream(
      model,
      (options) => {
        requestSignal = options.signal;
        return source;
      },
      {
        streamFirstResponseTimeoutMs: 20_000,
        streamIdleTimeoutMs: 40_000,
        onModelWait,
      },
    );
    if (streaming) source.push({ type: "text_delta", contentIndex: 0, delta: "output", partial });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(onModelWait).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        phase: streaming ? "stream" : "first_response",
      }),
    );
    partial.content = [
      { type: "text", text: "" },
      { type: "thinking", thinking: "" },
      { type: "toolCall", id: "empty", name: "", arguments: {} },
    ];
    source.push({ type: "text_start", contentIndex: 0, partial });
    source.push({ type: "text_delta", contentIndex: 0, delta: "", partial });
    source.push({ type: "text_end", contentIndex: 0, content: "", partial });
    source.push({ type: "thinking_start", contentIndex: 1, partial });
    source.push({ type: "thinking_delta", contentIndex: 1, delta: "", partial });
    source.push({ type: "thinking_end", contentIndex: 1, content: "", partial });
    source.push({ type: "toolcall_start", contentIndex: 2, partial });
    source.push({ type: "toolcall_delta", contentIndex: 2, delta: "", partial });
    const timeoutMs = streaming ? 40_000 : 20_000;
    await vi.advanceTimersByTimeAsync(timeoutMs - 15_001);
    expect(onModelWait).toHaveBeenCalledTimes(1);
    expect(requestSignal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await output.result()).toMatchObject({
      errorDetails: { code: "MODEL_STREAM_IDLE_TIMEOUT", timeoutMs, idleMs: timeoutMs },
    });
    expect(onModelWait).toHaveBeenCalledTimes(2);
    expect(onModelWait).toHaveBeenLastCalledWith(null);
    expect(vi.getTimerCount()).toBe(0);
    source.end(partial);
  },
);

it("enforces the recovery deadline even while output arrives and keeps manual retry distinct from Stop", async () => {
  vi.useFakeTimers();
  const model = fakeModel("");
  for (const manual of [false, true]) {
    const parent = new AbortController();
    const retry = new AbortController();
    const source = createAssistantMessageEventStream();
    const partial = emptyAssistant(model);
    const closed = { type: "toolCall" as const, id: "closed", name: "read", arguments: { path: "a" } };
    partial.content = [closed];
    source.push({ type: "toolcall_end", contentIndex: 0, toolCall: closed, partial });
    const output = guardModelStream(model, () => source, {
      signal: parent.signal,
      retrySignal: retry.signal,
      streamDeadlineMs: Date.now() + 100,
      streamIdleTimeoutMs: 1_000,
    });
    await vi.advanceTimersByTimeAsync(50);
    if (manual) retry.abort();
    else source.push({ type: "thinking_start", contentIndex: 1, partial });
    await vi.advanceTimersByTimeAsync(1_100);
    expect(await output.result()).toMatchObject({
      stopReason: "error",
      content: [closed],
      errorDetails: {
        retryable: manual,
        code: manual ? "MODEL_REQUEST_RETRY" : "MODEL_RECOVERY_DEADLINE",
      },
    });
    expect(parent.signal.aborted).toBe(false);
    source.end(partial);
    expect(vi.getTimerCount()).toBe(0);
  }
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

it("still stops an abort-ignoring provider when the event deadline is disabled", async () => {
  vi.useFakeTimers();
  const parent = new AbortController();
  const source = createAssistantMessageEventStream();
  const output = guardModelStream(fakeModel(""), () => source, {
    signal: parent.signal,
    streamIdleTimeoutMs: 0,
  });
  await vi.advanceTimersByTimeAsync(900_000);
  expect(vi.getTimerCount()).toBe(0);
  parent.abort();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await output.result()).toMatchObject({ stopReason: "aborted", errorDetails: { retryable: false } });
  source.end(emptyAssistant(fakeModel("")));
  expect(vi.getTimerCount()).toBe(0);
});
