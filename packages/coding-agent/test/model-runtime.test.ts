import { expect, it, vi } from "vitest";
import {
  type AssistantMessageEvent,
  AssistantMessageEventStream,
  createAssistantMessageEventStream,
  emptyAssistant,
  type Model,
  type SimpleStreamOptions,
  type TranscriptContext,
} from "zpi-ai";
import { ModelRuntime } from "zpi-coding-agent";
import { deferred, fakeConfig } from "../../../tests/fake-server.ts";

function fixture(getApiKey: () => Promise<string>) {
  const stream = vi.fn((model: Model, _context: TranscriptContext, _options?: SimpleStreamOptions) => {
    const output = createAssistantMessageEventStream();
    output.end(emptyAssistant(model));
    return output;
  });
  const runtime = new ModelRuntime();
  runtime.registerProvider("fake", { models: [fakeConfig("")], getApiKey, streamSimple: stream });
  const model = runtime.getModel("fake", "fake");
  if (!model) throw new Error("Missing fake model");
  return { runtime, model, stream };
}

it("resolves fresh dynamic credentials for each custom-provider request", async () => {
  const getApiKey = vi.fn().mockResolvedValueOnce("first-key").mockResolvedValueOnce("second-key");
  const { runtime, model, stream } = fixture(getApiKey);
  for (const key of ["first-key", "second-key"]) {
    expect((await runtime.streamSimple(model, { messages: [] }).result()).stopReason).toBe("stop");
    expect(stream.mock.lastCall?.[2]).toMatchObject({ apiKey: key });
  }
  expect(getApiKey).toHaveBeenCalledTimes(2);
});

it("keeps an explicit custom-provider credential override, including no-auth", async () => {
  const getApiKey = vi.fn(async () => "unused-key");
  const { runtime, model, stream } = fixture(getApiKey);
  for (const apiKey of ["request-key", ""]) {
    await runtime.streamSimple(model, { messages: [] }, { apiKey }).result();
    expect(stream.mock.lastCall?.[2]).toMatchObject({ apiKey });
  }
  expect(getApiKey).not.toHaveBeenCalled();
});

it("ends custom-provider requests when dynamic credential resolution fails", async () => {
  const { runtime, model, stream } = fixture(async () => {
    throw new Error("credentials unavailable");
  });
  expect(await runtime.streamSimple(model, { messages: [] }).result()).toMatchObject({
    stopReason: "error",
    errorMessage: "credentials unavailable",
  });
  expect(stream).not.toHaveBeenCalled();
});

it("cancels a stalled credential lookup and never starts the custom provider after cancellation", async () => {
  const lookup = Promise.withResolvers<string>();
  const started = deferred();
  const { runtime, model, stream } = fixture(() => {
    started.resolve();
    return lookup.promise;
  });
  const controller = new AbortController();
  const response = runtime.streamSimple(
    model,
    { messages: [] },
    { signal: controller.signal, streamIdleTimeoutMs: 0 },
  );
  await started.promise;
  controller.abort();
  expect((await response.result()).stopReason).toBe("aborted");
  lookup.resolve("late-key");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(stream).not.toHaveBeenCalled();
});

it("preserves closed tool calls and retry classification when a dynamic-key provider throws midstream", async () => {
  const { runtime, model } = fixture(async () => "local-key");
  class BrokenStream extends AssistantMessageEventStream {
    override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      const message = emptyAssistant(model);
      const call = { type: "toolCall" as const, id: "closed", name: "read", arguments: {} };
      message.content = [call, { ...call, id: "incomplete" }];
      yield { type: "start", partial: message };
      yield { type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message };
      throw Object.assign(new Error("connection interrupted"), { isRetryable: true });
    }
  }
  runtime.registerProvider("fake", { streamSimple: () => new BrokenStream() });
  expect(await runtime.streamSimple(model, { messages: [] }).result()).toMatchObject({
    stopReason: "error",
    content: [{ type: "toolCall", id: "closed" }],
    errorDetails: { retryable: true },
  });
});

it("closes the actual dynamic-key provider iterator after its terminal event", async () => {
  const { runtime, model } = fixture(async () => "local-key");
  let closed = false;
  class TerminalStream extends AssistantMessageEventStream {
    override async *[Symbol.asyncIterator](): AsyncGenerator<AssistantMessageEvent> {
      try {
        yield { type: "done", reason: "stop", message: emptyAssistant(model) };
        await new Promise(() => {});
      } finally {
        closed = true;
      }
    }
  }
  runtime.registerProvider("fake", { streamSimple: () => new TerminalStream() });
  expect((await runtime.streamSimple(model, { messages: [] }).result()).stopReason).toBe("stop");
  await vi.waitFor(() => expect(closed).toBe(true));
});

it("applies the stream idle deadline to asynchronous custom-provider credential lookup", async () => {
  vi.useFakeTimers();
  try {
    const lookup = Promise.withResolvers<string>();
    const { runtime, model, stream } = fixture(() => lookup.promise);
    const response = runtime.streamSimple(model, { messages: [] }, { streamIdleTimeoutMs: 10 });
    await vi.advanceTimersByTimeAsync(1010);
    expect(await response.result()).toMatchObject({
      stopReason: "error",
      errorDetails: { code: "MODEL_STREAM_IDLE_TIMEOUT", retryable: true },
    });
    lookup.resolve("late-key");
    await vi.advanceTimersByTimeAsync(0);
    expect(stream).not.toHaveBeenCalled();
  } finally {
    vi.useRealTimers();
  }
});
