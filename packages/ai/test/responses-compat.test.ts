import { expect, it, vi } from "vitest";
import { normalizeContext, streamSimple } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import type { AssistantMessageEvent, Model } from "../src/types.ts";

const model: Model = { ...fakeModel("https://gateway.example/v1"), api: "openai-responses" };
const message = (text: string, refusal = false) => ({
  type: "message",
  id: "msg_test",
  role: "assistant",
  status: "completed",
  phase: "final_answer",
  content: [refusal ? { type: "refusal", refusal: text } : { type: "output_text", text, annotations: [] }],
});
const response = (output: unknown[], status = "completed", extra = {}) => ({
  id: "resp_test",
  object: "response",
  model: "gateway-model",
  status,
  output,
  usage: {
    input_tokens: 10,
    output_tokens: 3,
    total_tokens: 13,
    input_tokens_details: { cached_tokens: 2 },
    output_tokens_details: { reasoning_tokens: 1 },
  },
  ...extra,
});
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

it.each([
  ["Hello", "Hello world"],
  ["Wrong prefix", "Correct text"],
  ["Too long", ""],
  ["Hello world", "Hello world"],
])("uses authoritative final text after receiving %j then %j", async (delta, final) => {
  const stream = streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    fetch: (async () =>
      sse([
        { type: "response.output_text.delta", item_id: "msg_test", content_index: 0, delta },
        { type: "response.output_item.done", item: message(delta) },
        { type: "response.completed", response: response([message(final)]) },
      ])) as typeof fetch,
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) events.push(event);
  expect((await stream.result()).content).toEqual([
    { type: "text", text: final, phase: "final_answer", textSignature: "msg_test" },
  ]);
  const ends = events.filter((event) => event.type === "text_end");
  expect(ends.at(-1)).toMatchObject({ content: final });
  const deltas = events.flatMap((event) => (event.type === "text_delta" ? [event.delta] : []));
  if (final.startsWith(delta)) expect(deltas.join("")).toBe(final);
});

it.each([false, true])(
  "uses text/refusal done events when terminal output is omitted (refusal=%s)",
  async (refusal) => {
    const stream = streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: "fake",
      fetch: (async () =>
        sse([
          {
            type: refusal ? "response.refusal.delta" : "response.output_text.delta",
            item_id: "msg_test",
            content_index: 0,
            delta: "Hello",
          },
          {
            type: refusal ? "response.refusal.done" : "response.output_text.done",
            item_id: "msg_test",
            content_index: 0,
            ...(refusal ? { refusal: "Hello world" } : { text: "Hello world" }),
          },
          { type: "response.completed", response: response([]) },
        ])) as typeof fetch,
    });
    expect((await stream.result()).content).toEqual([{ type: "text", text: "Hello world" }]);
  },
);

it.each(["application/json", "application/json; charset=utf-8", "application/vendor+json"])(
  "reads complete JSON with %s without a second request",
  async (contentType) => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify(
            response([
              { type: "reasoning", id: "rs_test", summary: [], encrypted_content: "opaque" },
              message("Full answer"),
              {
                type: "function_call",
                id: "fc_test",
                call_id: "call_test",
                name: "read",
                arguments: '{"path":"README.md"}',
              },
            ]),
          ),
          { headers: { "content-type": contentType, "x-request-id": "request-json" } },
        ),
    );
    const onResponse = vi.fn();
    const stream = streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: "fake",
      fetch: fetcher,
      onResponse,
    });
    const eventTypes: string[] = [];
    for await (const event of stream) eventTypes.push(event.type);
    const result = await stream.result();
    expect(result).toMatchObject({
      stopReason: "toolUse",
      responseId: "resp_test",
      responseModel: "gateway-model",
      usage: { input: 8, cacheRead: 2, output: 3, totalTokens: 13 },
    });
    expect(result.content).toEqual([
      {
        type: "thinking",
        thinking: "",
        thinkingSignature: JSON.stringify({
          type: "reasoning",
          id: "rs_test",
          summary: [],
          encrypted_content: "opaque",
        }),
      },
      { type: "text", text: "Full answer", phase: "final_answer", textSignature: "msg_test" },
      { type: "toolCall", id: "call_test|fc_test", name: "read", arguments: { path: "README.md" } },
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(onResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 200,
        headers: expect.objectContaining({ "x-request-id": "request-json" }),
      }),
      model,
    );
    expect(eventTypes).toContain("toolcall_end");
    expect(eventTypes.at(-1)).toBe("done");
  },
);

it.each(["json", "sse"])("preserves refusal and incomplete status through %s", async (transport) => {
  const body = response([message("Partial refusal", true)], "incomplete", {
    incomplete_details: { reason: "max_output_tokens" },
  });
  const result = await streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    fetch: (async () =>
      transport === "json"
        ? new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } })
        : sse([{ type: "response.incomplete", response: body }])) as typeof fetch,
  }).result();
  expect(result.stopReason).toBe("length");
  expect(result.content).toEqual([
    { type: "text", text: "Partial refusal", phase: "final_answer", textSignature: "msg_test" },
  ]);
});

it("accepts a complete text-only JSON answer after a retryable HTTP error", async () => {
  let attempt = 0;
  const fetcher = vi.fn(async () =>
    ++attempt === 1
      ? new Response('{"error":{"message":"retry"}}', {
          status: 503,
          headers: { "content-type": "application/json", "retry-after-ms": "1" },
        })
      : new Response(JSON.stringify(response([message("Complete answer")])), {
          headers: { "content-type": "application/json" },
        }),
  );
  const result = await streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    fetch: fetcher,
  }).result();
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(result.stopReason).toBe("stop");
  expect(result.content).toEqual([
    { type: "text", text: "Complete answer", phase: "final_answer", textSignature: "msg_test" },
  ]);
});

it.each([
  [
    response([], "failed", { error: { code: "server_error", message: "Gateway failure" } }),
    "Gateway failure",
  ],
  [response([], "incomplete", { incomplete_details: { reason: "content_filter" } }), "content_filter"],
  [response([], "in_progress"), "not terminal"],
  [{ output: [] }, "expected id"],
  [{ error: { code: "invalid_request", message: "Bad request" } }, "Bad request"],
  [null, "Invalid Responses JSON"],
])("does not report invalid or failed JSON as success: %j", async (body, error) => {
  const result = await streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    fetch: (async () =>
      new Response(JSON.stringify(body), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain(error);
});

it("separates reported cache writes from ordinary input and calculates their cost", async () => {
  const body = response([message("Answer")]);
  body.usage.input_tokens_details = {
    cached_tokens: 2,
    cache_write_tokens: 3,
  } as typeof body.usage.input_tokens_details;
  const result = await streamSimple(
    { ...model, cost: { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 2 } },
    normalizeContext({ messages: [] }),
    {
      apiKey: "fake",
      fetch: (async () => sse([{ type: "response.completed", response: body }])) as typeof fetch,
    },
  ).result();
  expect(result.usage).toMatchObject({ input: 5, cacheRead: 2, cacheWrite: 3, output: 3, totalTokens: 13 });
  expect(result.usage.cost.total).toBeCloseTo((5 + 0.2 + 3.75 + 6) / 1e6, 12);
});

it("preserves cancellation before reading a complete JSON response", async () => {
  const controller = new AbortController();
  const result = await streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    signal: controller.signal,
    onResponse: () => controller.abort(),
    fetch: (async () =>
      new Response(JSON.stringify(response([message("Must not be accepted")])), {
        headers: { "content-type": "application/json" },
      })) as typeof fetch,
  }).result();
  expect(result.stopReason).toBe("aborted");
  expect(result.content).toEqual([]);
});

it("rejects malformed JSON rather than accepting an empty successful answer", async () => {
  const result = await streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    fetch: (async () =>
      new Response("{", { headers: { "content-type": "application/json" } })) as typeof fetch,
  }).result();
  expect(result.stopReason).toBe("error");
  expect(result.usageAvailable).toBe(false);
});
