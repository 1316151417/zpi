import { expect, it } from "vitest";
import { normalizeContext } from "zpi-ai";
import { stream } from "zpi-ai/api/anthropic-messages";
import { deferred } from "../../../tests/fake-server.ts";
import { getModel } from "./helpers/anthropic.ts";

it("streams raw tool deltas and only materializes arguments at the explicit block boundary", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({
    start: (value) => {
      controller = value;
    },
  });
  const send = (event: { type: string; [key: string]: unknown }) =>
    controller.enqueue(new TextEncoder().encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  const firstDelta = deferred();
  const content = '中文 🌍\n\\"'.repeat(10000);
  const input = JSON.stringify({ path: "large.ts", content });
  const response = stream(getModel(), normalizeContext({ messages: [] }), {
    apiKey: "test",
    fetch: async () => new Response(body, { headers: { "content-type": "text/event-stream" } }),
  });
  let raw = "";
  let closed = false;
  const consume = (async () => {
    for await (const event of response) {
      if (event.type === "toolcall_delta") {
        raw += event.delta;
        if (raw.length === 127) {
          expect(event.partial.content[0]).toMatchObject({ type: "toolCall", arguments: {} });
          firstDelta.resolve();
        }
      }
      if (event.type === "toolcall_end") {
        closed = true;
        expect(event.toolCall.arguments).toEqual({ path: "large.ts", content });
        expect(event.toolCall).not.toHaveProperty("partialJson");
      }
    }
  })();
  send({ type: "message_start", message: { id: "input", usage: { input_tokens: 1, output_tokens: 0 } } });
  send({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "write", name: "write", input: {} },
  });
  send({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: input.slice(0, 127) },
  });
  await firstDelta.promise;
  expect(closed).toBe(false);
  for (let i = 127; i < input.length; i += 127)
    send({
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: input.slice(i, i + 127) },
    });
  send({ type: "content_block_stop", index: 0 });
  send({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 1 } });
  send({ type: "message_stop" });
  controller.close();
  await consume;
  expect(raw).toBe(input);
  expect(closed).toBe(true);
  expect((await response.result()).stopReason).toBe("toolUse");
});
