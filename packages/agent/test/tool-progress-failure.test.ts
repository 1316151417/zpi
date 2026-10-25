import { Type } from "typebox";
import { expect, it } from "vitest";
import type { AgentEvent, AgentTool } from "zpi-agent";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { createToolExecutor } from "../src/tool-execution.ts";

it("preserves the executed result and emits completion after a progress sink rejects", async () => {
  const model = fakeModel("");
  const events: AgentEvent[] = [];
  let effects = 0;
  const tool: AgentTool = {
    name: "write",
    label: "Write",
    description: "write",
    parameters: Type.Object({}),
    async execute(_id, _args, _signal, update) {
      effects++;
      update?.({ content: [{ type: "text", text: "progress" }], details: undefined });
      return { content: [{ type: "text", text: "written" }], details: { committed: true } };
    },
  };
  const executor = createToolExecutor(
    { messages: [], tools: [tool] },
    { ...emptyAssistant(model), stopReason: "toolUse" },
    { model, convertToLlm: (messages) => messages },
    async (event) => {
      events.push(event);
      if (event.type === "tool_execution_update") throw new Error("progress unavailable");
    },
  );
  const result = await (
    await executor.schedule({ type: "toolCall", id: "w", name: "write", arguments: {} })
  )();
  expect(effects).toBe(1);
  expect(result).toMatchObject({
    isError: false,
    content: [{ text: "written" }],
    details: { committed: true },
  });
  expect(events.at(-1)).toMatchObject({ type: "tool_execution_end", toolCallId: "w", isError: false });
});

it("settles the tool result before surfacing a progress sink failure and stops further model requests", async () => {
  const { Agent } = await import("zpi-agent");
  const { createAssistantMessageEventStream } = await import("zpi-ai");
  const model = fakeModel("");
  let requests = 0;
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          name: "write",
          label: "Write",
          description: "write",
          parameters: Type.Object({}),
          async execute(_id, _args, _signal, update) {
            update?.({ content: [{ type: "text", text: "progress" }], details: undefined });
            return { content: [{ type: "text", text: "written" }], details: undefined };
          },
        },
      ],
    },
    streamFn() {
      requests++;
      const stream = createAssistantMessageEventStream();
      stream.end({
        ...emptyAssistant(model),
        stopReason: "toolUse",
        content: [{ type: "toolCall", id: "w", name: "write", arguments: {} }],
      });
      return stream;
    },
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
    if (event.type === "tool_execution_update") throw new Error("progress sink failed");
  });
  await expect(agent.prompt("write")).rejects.toThrow("progress sink failed");
  expect(agent.state.messages.find((message) => message.role === "toolResult")).toMatchObject({
    content: [{ text: "written" }],
    isError: false,
  });
  expect(events).toContainEqual(expect.objectContaining({ type: "tool_execution_end", toolCallId: "w" }));
  expect(requests).toBe(1);
});
