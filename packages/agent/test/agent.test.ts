import type { AgentOptions, AgentTool, StreamFn } from "ZPI-agent";
import { Agent } from "ZPI-agent";
import type { Message } from "ZPI-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "ZPI-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { deferred, fakeModel } from "../../../tests/fake-server.ts";

const model = fakeModel("http://localhost");
function scripted(calls = true): { streamFn: StreamFn; inputs: Message[][] } {
  let n = 0;
  const inputs: Message[][] = [];
  return {
    inputs,
    streamFn: (_, context) => {
      inputs.push(structuredClone(context.messages));
      const stream = createAssistantMessageEventStream();
      const m = emptyAssistant(model);
      m.content =
        n++ === 0 && calls
          ? [{ type: "toolCall", id: "id", name: "double", arguments: { value: 4 } }]
          : [{ type: "text", text: "done" }];
      m.stopReason = m.content[0].type === "toolCall" ? "toolUse" : "stop";
      stream.push({ type: "start", partial: m });
      stream.push({ type: "done", reason: m.stopReason, message: m });
      return stream;
    },
  };
}
const schema = Type.Object({ value: Type.Number() }, { additionalProperties: false });
const tool: AgentTool<typeof schema> = {
  name: "double",
  label: "Double",
  description: "double",
  parameters: schema,
  async execute(_, p) {
    return { content: [{ type: "text", text: String(p.value * 2) }], details: { value: p.value * 2 } };
  },
};
function make(options: Partial<AgentOptions> = {}, s = scripted()) {
  return {
    agent: new Agent({ initialState: { model, tools: [tool] }, streamFn: s.streamFn, ...options }),
    inputs: s.inputs,
  };
}
describe("Agent execution lifecycle", () => {
  it("pairs results and emits ordered lifecycle", async () => {
    const { agent, inputs } = make();
    const events: string[] = [];
    agent.subscribe((e) => {
      events.push(e.type);
    });
    await agent.prompt("go");
    expect(inputs).toHaveLength(2);
    expect(inputs[1].find((m) => m.role === "toolResult")).toMatchObject({
      toolCallId: "id",
      content: [{ type: "text", text: "8" }],
    });
    expect(events).toEqual([
      "agent_start",
      "turn_start",
      "message_start",
      "message_end",
      "message_start",
      "message_end",
      "tool_execution_start",
      "tool_execution_end",
      "message_start",
      "message_end",
      "turn_end",
      "turn_start",
      "message_start",
      "message_end",
      "turn_end",
      "agent_end",
    ]);
    expect(agent.state.isStreaming).toBe(false);
  });
  it("blocked calls become error results without running the after hook, as in Pi", async () => {
    let after = 0;
    const { agent, inputs } = make({
      beforeToolCall: async () => ({ block: true, reason: "denied" }),
      afterToolCall: async () => {
        after++;
        return undefined;
      },
    });
    await agent.prompt("go");
    expect(inputs[1].find((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
      content: [{ type: "text", text: "denied" }],
    });
    expect(after).toBe(0);
  });
  it("busy and independent instances", async () => {
    const gate = deferred();
    const { agent } = make({
      beforeToolCall: async () => {
        await gate.promise;
        return undefined;
      },
    });
    const run = agent.prompt("go");
    await expect(agent.prompt("again")).rejects.toThrow("busy");
    const { agent: b } = make({}, scripted(false));
    await b.prompt("independent");
    expect(agent.state.isStreaming).toBe(true);
    agent.abort();
    gate.resolve();
    await run;
    expect(agent.state.messages.at(-1)).toMatchObject({ role: "toolResult", isError: true });
  });
});

it("parallel starts both tools before completion; results retain source order and late updates are ignored", async () => {
  const gate = deferred();
  const started = deferred();
  let count = 0;
  let request = 0;
  let late: (() => void) | undefined;
  const events: string[] = [];
  const agent = new Agent({
    initialState: {
      model,
      tools: [
        {
          ...tool,
          async execute(id, _, __, update) {
            if (++count === 2) started.resolve();
            if (id === "first") await gate.promise;
            late = () => update?.({ content: [{ type: "text", text: "late" }], details: undefined });
            return { content: [{ type: "text", text: id }], details: undefined };
          },
        },
      ],
    },
    streamFn: () => {
      const stream = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      message.content =
        request++ === 0
          ? [
              { type: "toolCall", id: "first", name: "double", arguments: { value: 1 } },
              { type: "toolCall", id: "second", name: "double", arguments: { value: 2 } },
            ]
          : [{ type: "text", text: "done" }];
      message.stopReason = request === 1 ? "toolUse" : "stop";
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: message.stopReason, message });
      return stream;
    },
  });
  agent.subscribe((event) => {
    events.push(event.type);
  });
  const run = agent.prompt("go");
  await started.promise;
  expect(agent.state.pendingToolCalls.size).toBe(2);
  gate.resolve();
  await run;
  late?.();
  await Promise.resolve();
  expect(events).not.toContain("tool_execution_update");
  expect(agent.state.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual([
    "first",
    "second",
  ]);
});
