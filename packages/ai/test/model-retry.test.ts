import {
  emptyAssistant,
  isRetryableAssistantError,
  normalizeContext,
  retryAssistantCall,
  retryDelayMs,
  streamSimple,
} from "ZPI-ai";
import { afterEach, expect, it, vi } from "vitest";
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
  ])
    expect(isRetryableAssistantError(failed(text))).toBe(true);
  for (const text of [
    "429 insufficient_quota",
    "429 billing limit",
    "GoUsageLimitError",
    "401 unauthorized",
    "Monthly usage limit reached",
  ])
    expect(isRetryableAssistantError(failed(text))).toBe(false);
  expect(
    modelFailure(
      Object.assign(new Error("busy"), { status: 429, headers: new Headers({ "retry-after-ms": "120000" }) }),
    ),
  ).toMatchObject({ status: 429, retryAfterMs: 120000 });
});

it("makes four agent attempts, reports 2/4/8 second waits, and leaves empty success alone", async () => {
  vi.useFakeTimers();
  const produce = vi.fn(async () => failed("503 busy"));
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
});

it("cancels an agent backoff immediately and never retries terminal failures", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const produce = vi.fn(async () => failed("terminated"));
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
});

it.each(["openai-completions", "openai-responses"] as const)(
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
      { apiKey: "local", fetch: fetcher },
    );
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    expect((await stream.result()).content).toEqual([{ type: "text", text: "recovered" }]);
    expect(types.filter((type) => type === "start")).toHaveLength(1);
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);

it.each(["openai-completions", "openai-responses"] as const)(
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
    expect(fetcher).toHaveBeenCalledTimes(3);
  },
);
