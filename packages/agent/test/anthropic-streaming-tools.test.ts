import { Agent, type AgentTool } from "ZPI-agent";
import { streamSimple } from "ZPI-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { deferred } from "../../../tests/fake-server.ts";
import { getModel } from "../../ai/test/helpers/anthropic.ts";

it("executes an Anthropic read after content_block_stop before message_stop and reuses its result", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const encoder = new TextEncoder();
  const emit = (event: { type: string; [key: string]: unknown }) =>
    controller.enqueue(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
  const body = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const completed = deferred();
  let executions = 0;
  let requests = 0;
  const tool: AgentTool = {
    name: "read",
    label: "Read",
    description: "Read a file",
    parameters: Type.Object({ path: Type.String() }),
    metadata: {
      readOnly: true,
      concurrentSafe: true,
      destructive: false,
      needsApproval: false,
      requiresUserInteraction: false,
      sideEffectScope: "none",
    },
    async execute(_id, args) {
      expect(args).toEqual({ path: "README.md" });
      executions++;
      return { content: [{ type: "text", text: "early read" }], details: undefined };
    },
  };
  const agent = new Agent({
    initialState: { model: getModel(), tools: [tool] },
    streamFn: (model, context, options) =>
      streamSimple(model, context, {
        ...options,
        apiKey: "test-key",
        fetch: (async (_url, init) => {
          if (++requests === 1)
            return new Response(body, { headers: { "content-type": "text/event-stream" } });
          expect(String(init?.body)).toContain("early read");
          return new Response(
            [
              {
                type: "message_start",
                message: { id: "second", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
              },
              { type: "content_block_start", index: 0, content_block: { type: "text", text: "done" } },
              { type: "content_block_stop", index: 0 },
              { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
              { type: "message_stop" },
            ]
              .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
              .join(""),
          );
        }) as typeof fetch,
      }),
  });
  agent.subscribe((event) => {
    if (event.type === "tool_execution_end") completed.resolve();
  });
  const run = agent.prompt("read README.md");
  emit({
    type: "message_start",
    message: { id: "first", model: agent.state.model.id, usage: { input_tokens: 10, output_tokens: 0 } },
  });
  emit({
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "read", name: "read", input: {} },
  });
  emit({
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"path":"README.md"}' },
  });
  emit({ type: "content_block_stop", index: 0 });
  await completed.promise;
  expect(agent.state.isStreaming).toBe(true);
  expect(requests).toBe(1);
  emit({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 3 } });
  emit({ type: "message_stop" });
  controller.close();
  await run;
  expect(executions).toBe(1);
  expect(requests).toBe(2);
  expect(agent.state.messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
});
