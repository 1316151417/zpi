import { expect, it } from "vitest";
import { isRecoverableLength, normalizeContext, streamSimple } from "zpi-ai";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";
import type { Api } from "../src/types.ts";

const apis = ["openai-completions", "openai-responses", "anthropic-messages"] as const;
const truncated = '{"path":"file.txt","content":"unfinished';

function response(api: Api, input: string, length: boolean, objectInput = false): Response {
  const call = {
    type: "function_call",
    id: "fc_test",
    call_id: "call_test",
    name: "write",
    arguments: input,
    status: length ? "incomplete" : "completed",
  };
  const events =
    api === "openai-completions"
      ? [
          chunk({
            tool_calls: [{ index: 0, id: "call_test", function: { name: "write", arguments: input } }],
          }),
          {
            ...chunk({}, length ? "length" : "tool_calls"),
            usage: { prompt_tokens: 10, completion_tokens: 128, total_tokens: 138 },
          },
        ]
      : api === "openai-responses"
        ? [
            { type: "response.output_item.added", item: { ...call, arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: call.id, delta: input },
            { type: "response.output_item.done", item: call },
            {
              type: length ? "response.incomplete" : "response.completed",
              response: {
                id: "response_test",
                model: "fake",
                status: length ? "incomplete" : "completed",
                output: [call],
                usage: { input_tokens: 10, output_tokens: 128, total_tokens: 138 },
                ...(length ? { incomplete_details: { reason: "max_output_tokens" } } : {}),
              },
            },
          ]
        : [
            {
              type: "message_start",
              message: { id: "message_test", model: "fake", usage: { input_tokens: 10, output_tokens: 0 } },
            },
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: "call_test",
                name: "write",
                input: objectInput ? JSON.parse(input) : {},
              },
            },
            ...(objectInput
              ? []
              : [
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: { type: "input_json_delta", partial_json: input },
                  },
                ]),
            { type: "content_block_stop", index: 0 },
            {
              type: "message_delta",
              delta: { stop_reason: length ? "max_tokens" : "tool_use" },
              usage: { output_tokens: 128 },
            },
            { type: "message_stop" },
          ];
  return new Response(
    events
      .map(
        (event) =>
          `${api === "anthropic-messages" && "type" in event ? `event: ${event.type}\n` : ""}data: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );
}

it.each(apis)("preserves %s length and usage when the final tool JSON is cut off", async (api) => {
  const events = streamSimple(
    { ...fakeModel("https://example.invalid/v1"), api },
    normalizeContext({ messages: [] }),
    {
      apiKey: "test",
      fetch: async () => response(api, truncated, true),
    },
  );
  const closed: string[] = [];
  for await (const event of events) if (event.type === "toolcall_end") closed.push(event.toolCall.id);
  const result = await events.result();
  expect(result.stopReason).toBe("length");
  expect(result.usageAvailable).toBe(true);
  expect(result.usage).toMatchObject({ input: 10, output: 128, totalTokens: 138 });
  expect(result.usage.cost.total).toBeGreaterThan(0);
  expect(isRecoverableLength(result, 4096)).toBe(true);
  expect(result.errorMessage).toBeUndefined();
  expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
  expect(closed).toEqual([]);
});

it.each(apis)("does not finalize malformed %s tool JSON as executable arguments", async (api) => {
  const events = streamSimple(
    { ...fakeModel("https://example.invalid/v1"), api },
    normalizeContext({ messages: [] }),
    {
      apiKey: "test",
      fetch: async () => response(api, truncated, false),
    },
  );
  const closed: string[] = [];
  for await (const event of events) if (event.type === "toolcall_end") closed.push(event.toolCall.id);
  const result = await events.result();
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toBeTruthy();
  expect(result.content.some((block) => block.type === "toolCall")).toBe(false);
  expect(closed).toEqual([]);
});

it.each([
  { input: "{}", objectInput: false },
  { input: "{}", objectInput: true },
  { input: '{"path":"file.txt","content":"complete"}', objectInput: true },
])("preserves valid Anthropic tool input $input (object=$objectInput)", async ({ input, objectInput }) => {
  const result = await streamSimple(
    { ...fakeModel("https://example.invalid/v1"), api: "anthropic-messages" },
    normalizeContext({ messages: [] }),
    { apiKey: "test", fetch: async () => response("anthropic-messages", input, false, objectInput) },
  ).result();
  expect(result.stopReason).toBe("toolUse");
  expect(result.content).toEqual([
    { type: "toolCall", id: "call_test", name: "write", arguments: JSON.parse(input) },
  ]);
});
