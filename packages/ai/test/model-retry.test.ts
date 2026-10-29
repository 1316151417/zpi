import { afterEach, expect, it, vi } from "vitest";
import {
  emptyAssistant,
  isRetryableAssistantError,
  ModelRequestRetryError,
  normalizeContext,
  retryAssistantCall,
  retryDelayMs,
  streamSimple,
} from "zpi-ai";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";
import { modelFailure } from "../src/utils/model-retry.ts";

const policy = { enabled: true, maxRetries: 3, baseDelayMs: 2000 };
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
const failed = (errorMessage: string) => ({
  ...emptyAssistant(fakeModel("")),
  stopReason: "error" as const,
  errorMessage,
});

it("starts the recovery budget after the first failure and passes its absolute deadline only to retries", async () => {
  vi.useFakeTimers();
  const startedAt = Date.now();
  const deadlines: (number | undefined)[] = [];
  const produce = vi.fn(async (deadline?: number) => {
    deadlines.push(deadline);
    await new Promise((resolve) => setTimeout(resolve, 30));
    return failed("network error");
  });
  const result = retryAssistantCall(produce, { ...policy, baseDelayMs: 10, maxElapsedMs: 100 }, undefined);
  await vi.runAllTimersAsync();
  expect((await result).stopReason).toBe("error");
  expect(deadlines).toEqual([undefined, startedAt + 130, startedAt + 130]);
});

it("allows an explicit retry during compaction even when automatic retries are disabled", async () => {
  const error = new ModelRequestRetryError();
  const manual = { ...failed(error.message), errorDetails: modelFailure(error) };
  expect(manual.errorDetails).toMatchObject({ retryable: true, code: "MODEL_REQUEST_RETRY" });
  expect(isRetryableAssistantError(manual)).toBe(true);
  const success = emptyAssistant(fakeModel(""));
  const produce = vi.fn().mockResolvedValueOnce(manual).mockResolvedValueOnce(success);
  expect(await retryAssistantCall(produce, { ...policy, enabled: false }, undefined)).toBe(success);
  expect(produce).toHaveBeenCalledTimes(2);
});

it("uses Pi deterministic agent backoff and excludes subscription/billing limits", () => {
  expect([1, 2, 3, 4, 5, 6, 10].map((n) => retryDelayMs(policy, n))).toEqual([
    2000, 4000, 8000, 16000, 32000, 60000, 60000,
  ]);
  expect(retryDelayMs({ ...policy, maxAgentDelayMs: 3000 }, 3)).toBe(3000);
  for (const text of [
    "503 server error",
    "terminated",
    "fetch failed",
    "Stream ended without terminal event",
    "Server requested 120s retry delay",
    "net::ERR_CONNECTION_CLOSED",
    "net::ERR_CONNECTION_RESET",
    "net::ERR_NETWORK_CHANGED",
    "net::ERR_HTTP2_PROTOCOL_ERROR",
    "net::ERR_QUIC_PROTOCOL_ERROR",
    "net::err_quic_protocol_error",
  ])
    expect(isRetryableAssistantError(failed(text))).toBe(true);
  for (const text of [
    "429 insufficient_quota",
    "429 billing limit",
    "net::ERR_QUIC_PROTOCOL_ERROR: insufficient_quota",
    "GoUsageLimitError",
    "401 unauthorized",
    "Monthly usage limit reached",
    "net::ERR_CERT_AUTHORITY_INVALID",
  ])
    expect(isRetryableAssistantError(failed(text))).toBe(false);
  expect(
    modelFailure(
      Object.assign(new Error("busy"), { status: 429, headers: new Headers({ "retry-after-ms": "120000" }) }),
    ),
  ).toMatchObject({ status: 429, retryAfterMs: 120000 });
});

it.each(["503 busy", "net::ERR_QUIC_PROTOCOL_ERROR"])(
  "makes four agent attempts for %s, reports 2/4/8 second waits, and leaves empty success alone",
  async (errorMessage) => {
    vi.useFakeTimers();
    const produce = vi.fn(async () => failed(errorMessage));
    const delays: number[] = [];
    const run = retryAssistantCall(produce, policy, undefined, {
      onRetryScheduled: (_attempt, _max, delay) => {
        delays.push(delay);
      },
    });
    await vi.runAllTimersAsync();
    expect((await run).stopReason).toBe("error");
    expect(produce).toHaveBeenCalledTimes(4);
    expect(delays).toEqual([2000, 4000, 8000]);
    const empty = { ...emptyAssistant(fakeModel("")), stopReason: "stop" as const };
    const success = vi.fn(async () => empty);
    expect(await retryAssistantCall(success, policy, undefined)).toBe(empty);
    expect(success).toHaveBeenCalledTimes(1);
  },
);

it.each(["terminated", "net::ERR_QUIC_PROTOCOL_ERROR"])(
  "cancels %s backoff immediately and never retries terminal failures",
  async (errorMessage) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const produce = vi.fn(async () => failed(errorMessage));
    const run = retryAssistantCall(produce, policy, controller.signal, {
      onRetryScheduled: () => {
        controller.abort();
      },
    });
    expect((await run).stopReason).toBe("aborted");
    expect(produce).toHaveBeenCalledTimes(1);
    const terminal = vi.fn(async () => failed("429 insufficient_quota"));
    await retryAssistantCall(terminal, policy, undefined);
    expect(terminal).toHaveBeenCalledTimes(1);
  },
);

it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
  "uses two provider retries by default through %s",
  async (api) => {
    let attempts = 0;
    const fetcher = vi.fn(async () => {
      if (++attempts <= 2)
        return new Response('{"error":{"message":"busy"}}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        });
      const data =
        api === "openai-completions"
          ? [chunk({ content: "recovered" }), chunk({}, "stop")]
          : api === "anthropic-messages"
            ? [
                {
                  type: "message_start",
                  message: { id: "a", model: "fake", usage: { input_tokens: 1, output_tokens: 0 } },
                },
                { type: "content_block_start", index: 0, content_block: { type: "text", text: "recovered" } },
                { type: "content_block_stop", index: 0 },
                { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
                { type: "message_stop" },
              ]
            : [
                { type: "response.output_text.delta", item_id: "m", content_index: 0, delta: "recovered" },
                {
                  type: "response.completed",
                  response: { id: "r", status: "completed", output: [], usage: null },
                },
              ];
      return new Response(
        data
          .map(
            (event) =>
              `${api === "anthropic-messages" && "type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
          )
          .join(""),
        {
          headers: { "content-type": "text/event-stream" },
        },
      );
    });
    const stream = streamSimple(
      { ...fakeModel("http://local/v1"), api },
      normalizeContext({ messages: [] }),
      { apiKey: "local", fetch: fetcher },
    );
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "recovered" }]);
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);

it.each(["openai-completions", "openai-responses", "anthropic-messages"] as const)(
  "preserves quota error codes from %s parsed bodies for Pi retry classification",
  async (api) => {
    const fetcher = vi.fn(
      async () =>
        new Response('{"error":{"message":"Rate limit reached for requests","code":"insufficient_quota"}}', {
          status: 429,
          headers: { "content-type": "application/json", "retry-after": "0" },
        }),
    );
    const result = await streamSimple(
      { ...fakeModel("http://local/v1"), api },
      normalizeContext({ messages: [] }),
      { apiKey: "local", fetch: fetcher },
    ).result();
    expect(result.errorMessage).toContain("insufficient_quota");
    expect(isRetryableAssistantError(result)).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  },
);

it("uses structured retry facts before display text and retains unknown-error fallback", () => {
  for (const [error, retryable] of [
    [Object.assign(new Error("ENETUNREACH"), { code: "ENETUNREACH" }), true],
    [Object.assign(new Error("fetch failed"), { cause: { code: "CERT_HAS_EXPIRED" } }), false],
    [
      Object.assign(new Error("503 busy"), {
        status: 503,
        headers: new Headers({ "x-should-retry": "false" }),
      }),
      false,
    ],
    [Object.assign(new Error("try again"), { status: 400 }), false],
    [new Error("net::ERR_NETWORK_CHANGED"), true],
  ] as const) {
    expect(isRetryableAssistantError({ ...failed(error.message), errorDetails: modelFailure(error) })).toBe(
      retryable,
    );
  }
});

it("honors server backoff in summary retries and refuses retries beyond the recovery deadline", async () => {
  const response = {
    ...failed("429 busy"),
    errorDetails: modelFailure(
      Object.assign(new Error("busy"), { status: 429, headers: new Headers({ "retry-after": "120" }) }),
    ),
  };
  const delays: number[] = [];
  const produce = vi
    .fn()
    .mockResolvedValueOnce(response)
    .mockResolvedValue(emptyAssistant(fakeModel("")));
  await retryAssistantCall(produce, policy, undefined, {
    onRetryScheduled: (_attempt, _max, delay) => {
      delays.push(delay);
    },
    waitBeforeRetry: async () => false,
  });
  expect(delays).toEqual([120000]);
  const bounded = vi.fn().mockResolvedValue(response);
  await retryAssistantCall(bounded, { ...policy, maxElapsedMs: 60000 }, undefined);
  expect(bounded).toHaveBeenCalledTimes(1);
});

it("caps empty summary recovery at one retry and rejects waits that would overflow timers", async () => {
  const response = {
    ...failed("empty response"),
    errorDetails: { code: "EMPTY_MODEL_RESPONSE", retryable: true },
  };
  const produce = vi.fn().mockResolvedValue(response);
  await retryAssistantCall(produce, { ...policy, baseDelayMs: 0 }, undefined);
  expect(produce).toHaveBeenCalledTimes(2);
  expect(retryDelayMs(policy, 1, 2147483648)).toBe(Infinity);
});
