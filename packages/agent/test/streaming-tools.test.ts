import type { AgentEvent, AgentOptions, AgentTool, ToolExecutionMetadata } from "ZPI-agent";
import { Agent } from "ZPI-agent";
import type { AssistantMessage, ToolCall } from "ZPI-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "ZPI-ai";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { deferred, fakeModel } from "../../../tests/fake-server.ts";

const model = fakeModel("http://localhost");
const safe: ToolExecutionMetadata = {
  readOnly: true,
  concurrentSafe: true,
  destructive: false,
  needsApproval: false,
  requiresUserInteraction: false,
  sideEffectScope: "none",
};
const call = (id = "read", name = "read"): ToolCall => ({ type: "toolCall", id, name, arguments: {} });
const result = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const tool: AgentTool = {
  name: "read",
  label: "Read",
  description: "read",
  parameters: Type.Object({}),
  metadata: safe,
  async execute(id) {
    return result(id);
  },
};

function fixture(tools: AgentTool[] = [tool], options: Partial<AgentOptions> = {}) {
  const stream = createAssistantMessageEventStream();
  const message = emptyAssistant(model);
  stream.push({ type: "start", partial: message });
  let requests = 0;
  const agent = new Agent({
    initialState: { model, tools },
    ...options,
    streamFn: () => {
      if (++requests === 1) return stream;
      const next = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      output.content = [{ type: "text", text: "finished" }];
      next.push({ type: "start", partial: output });
      next.end(output);
      return next;
    },
  });
  const events: AgentEvent[] = [];
  agent.subscribe((event) => {
    events.push(event);
  });
  function close(c: ToolCall) {
    const index = message.content.findIndex((block) => block.type === "toolCall" && block.id === c.id);
    if (index < 0) message.content.push(c);
    stream.push({
      type: "toolcall_end",
      contentIndex: index < 0 ? message.content.length - 1 : index,
      toolCall: c,
      partial: message,
    });
  }
  function finish() {
    message.stopReason = "toolUse";
    stream.end(message);
  }
  return { agent, stream, message, events, close, finish };
}

it("executes a closed safe call while the model is still streaming, deduplicates it and reuses its result", async () => {
  let executions = 0;
  const ended = deferred();
  const f = fixture([
    {
      ...tool,
      async execute() {
        executions++;
        return result("early");
      },
    },
  ]);
  f.agent.subscribe((event) => {
    if (event.type === "tool_execution_end") ended.resolve();
  });
  const run = f.agent.prompt("read");
  f.close(call());
  f.close(call());
  await ended.promise;
  expect(f.agent.state.isStreaming).toBe(true);
  expect(f.events.filter((e) => e.type === "message_end" && e.message.role === "assistant")).toHaveLength(0);
  // A later model delta cannot mutate the closed input consumed by the tool.
  f.message.content.push({ type: "text", text: "model tail" });
  f.stream.push({ type: "text_delta", contentIndex: 1, delta: "model tail", partial: f.message });
  f.finish();
  await run;
  expect(executions).toBe(1);
  expect(f.agent.state.messages.find((m) => m.role === "toolResult")).toMatchObject({
    content: [{ text: "early" }],
  });
});

it("does not infer completion from parsable argument deltas", async () => {
  let executions = 0;
  const received = deferred();
  const f = fixture([
    {
      ...tool,
      async execute() {
        executions++;
        return result("read");
      },
    },
  ]);
  f.agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_delta")
      received.resolve();
  });
  const run = f.agent.prompt("read");
  f.message.content = [call()];
  f.stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "{}", partial: f.message });
  await received.promise;
  expect(executions).toBe(0);
  f.close(call());
  f.finish();
  await run;
  expect(executions).toBe(1);
});

for (const [name, override] of [
  ["missing metadata", { metadata: undefined }],
  ["not read-only", { metadata: { ...safe, readOnly: false } }],
  ["not concurrent-safe", { metadata: { ...safe, concurrentSafe: false } }],
  ["destructive", { metadata: { ...safe, destructive: true } }],
  ["approval", { metadata: { ...safe, needsApproval: true } }],
  ["interaction", { metadata: { ...safe, requiresUserInteraction: true } }],
  ["entry interaction", { requiresUserInteraction: true }],
  ["side effects", { metadata: { ...safe, sideEffectScope: "workspace" as const } }],
  ["permission override", { permission: { sideEffectScope: "network" as const } }],
] as const) {
  it(`defers ${name} tools until the response ends`, async () => {
    let executions = 0;
    const received = deferred();
    const f = fixture([
      {
        ...tool,
        ...override,
        async execute() {
          executions++;
          return result("read");
        },
      },
    ]);
    f.agent.subscribe((event) => {
      if (event.type === "message_update") received.resolve();
    });
    const run = f.agent.prompt("read");
    f.close(call());
    await received.promise;
    expect(executions).toBe(0);
    f.finish();
    await run;
    expect(executions).toBe(1);
  });
}

it("honors the streaming off switch", async () => {
  let executions = 0;
  const received = deferred();
  const f = fixture(
    [
      {
        ...tool,
        async execute() {
          executions++;
          return result("read");
        },
      },
    ],
    { streamingToolExecution: "off" },
  );
  f.agent.subscribe((event) => {
    if (event.type === "message_update") received.resolve();
  });
  const run = f.agent.prompt("read");
  f.close(call());
  await received.promise;
  expect(executions).toBe(0);
  f.finish();
  await run;
  expect(executions).toBe(1);
});

it("uses ZCode's entry interaction and permission overrides for streaming admission", async () => {
  const ended = deferred();
  const f = fixture([
    {
      ...tool,
      metadata: { ...safe, requiresUserInteraction: true, sideEffectScope: "workspace" },
      requiresUserInteraction: false,
      permission: { sideEffectScope: "none" },
    },
  ]);
  f.agent.subscribe((event) => {
    if (event.type === "tool_execution_end") ended.resolve();
  });
  const run = f.agent.prompt("read");
  f.close(call());
  await ended.promise;
  expect(f.agent.state.isStreaming).toBe(true);
  f.finish();
  await run;
});

it("does not execute a blocked streamed call or run its after hook", async () => {
  let executed = 0,
    after = 0;
  const ended = deferred();
  const f = fixture(
    [
      {
        ...tool,
        async execute() {
          executed++;
          return result("read");
        },
      },
    ],
    {
      beforeToolCall: async () => ({ block: true, reason: "blocked" }),
      afterToolCall: async () => {
        after++;
        return undefined;
      },
    },
  );
  f.agent.subscribe((event) => {
    if (event.type === "tool_execution_end") ended.resolve();
  });
  const run = f.agent.prompt("read");
  f.close(call());
  await ended.promise;
  f.finish();
  await run;
  expect(executed).toBe(0);
  expect(after).toBe(0);
  expect(f.agent.state.messages.find((m) => m.role === "toolResult")).toMatchObject({
    isError: true,
    content: [{ text: "blocked" }],
  });
});

it("treats a streamed tool listener failure as fatal and cancels model generation", async () => {
  const fault = deferred();
  const f = fixture();
  f.agent.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      fault.resolve();
      throw new Error("sink failed");
    }
  });
  const run = f.agent.prompt("read");
  f.close(call());
  await fault.promise;
  expect(f.agent.signal?.aborted).toBe(true);
  f.finish();
  await expect(run).rejects.toThrow("sink failed");
  expect(f.agent.state.isStreaming).toBe(false);
  expect(f.agent.state.pendingToolCalls.size).toBe(0);
});

it("pairs every streamed call on cancellation without executing deferred writes", async () => {
  const started = deferred(),
    gate = deferred();
  let reads = 0,
    writes = 0;
  const f = fixture([
    {
      ...tool,
      async execute() {
        if (++reads === 2) started.resolve();
        await gate.promise;
        return result("read");
      },
    },
    {
      ...tool,
      name: "write",
      metadata: undefined,
      async execute() {
        writes++;
        return result("write");
      },
    },
  ]);
  const run = f.agent.prompt("read twice and write");
  f.close(call("first"));
  f.close(call("second"));
  f.close(call("write", "write"));
  await started.promise;
  f.agent.abort();
  f.message.stopReason = "aborted";
  f.stream.end(f.message);
  await run;
  expect(writes).toBe(0);
  expect(f.agent.state.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual([
    "first",
    "second",
    "write",
  ]);
  expect(f.agent.state.pendingToolCalls.size).toBe(0);
  gate.resolve();
});

it("recovery retains completed reads and fails unexecuted writes without replaying either", async () => {
  let reads = 0,
    writes = 0;
  const ended = deferred();
  const f = fixture([
    {
      ...tool,
      async execute() {
        reads++;
        return result("completed read");
      },
    },
    {
      ...tool,
      name: "write",
      metadata: undefined,
      async execute() {
        writes++;
        return result("write");
      },
    },
  ]);
  f.agent.subscribe((event) => {
    if (event.type === "tool_execution_end") ended.resolve();
  });
  const run = f.agent.prompt("read and write");
  f.close(call());
  await ended.promise;
  f.close(call("write", "write"));
  const recovered: AssistantMessage = { ...emptyAssistant(model), content: [call(), call("write", "write")] };
  f.stream.push({ type: "reset", partial: recovered });
  f.stream.push({ type: "toolcall_end", contentIndex: 0, toolCall: call(), partial: recovered });
  f.stream.push({
    type: "toolcall_end",
    contentIndex: 1,
    toolCall: call("write", "write"),
    partial: recovered,
  });
  recovered.stopReason = "toolUse";
  f.stream.end(recovered);
  await run;
  expect(reads).toBe(1);
  expect(writes).toBe(0);
  const results = f.agent.state.messages.filter((m) => m.role === "toolResult");
  expect(results).toHaveLength(2);
  expect(results[0]).toMatchObject({ content: [{ text: "completed read" }], isError: false });
  expect(results[1]).toMatchObject({ isError: true, details: { reason: "not_executed" } });
});

for (const duringDrain of [false, true]) {
  it(`bounds cancellation of a noncooperative streamed tool ${duringDrain ? "during drain" : "during generation"} and ignores late events`, async () => {
    const started = deferred(),
      gate = deferred();
    let toolSignal: AbortSignal | undefined;
    const f = fixture([
      {
        ...tool,
        async execute(_, __, signal, update) {
          toolSignal = signal;
          started.resolve();
          await gate.promise;
          update?.(result("late"));
          return result("late");
        },
      },
    ]);
    const run = f.agent.prompt("read");
    f.close(call());
    await started.promise;
    if (duringDrain) f.finish();
    f.agent.abort();
    if (!duringDrain) {
      f.message.stopReason = "aborted";
      f.stream.end(f.message);
    }
    await run;
    expect(toolSignal?.aborted).toBe(true);
    expect(f.agent.state.messages.find((m) => m.role === "toolResult")).toMatchObject({
      isError: true,
      details: { reason: "unknown_execution_state" },
    });
    const count = f.events.length;
    gate.resolve();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.events).toHaveLength(count);
    expect(f.agent.state.pendingToolCalls.size).toBe(0);
  });
}

for (const sequential of [false, true]) {
  it(`matches Pi's ${sequential ? "tool-level sequential override" : "ordered preparation and parallel batch"}`, async () => {
    const first = deferred(),
      second = deferred(),
      release = deferred();
    const order: string[] = [];
    const f = fixture(
      [
        {
          ...tool,
          metadata: undefined,
          executionMode: sequential ? "sequential" : undefined,
          async execute(id) {
            order.push(`execute:${id}`);
            if (id === "first") {
              first.resolve();
              await release.promise;
            } else second.resolve();
            return result(id);
          },
        },
      ],
      {
        beforeToolCall: async ({ toolCall }) => {
          order.push(`prepare:${toolCall.id}`);
          return undefined;
        },
      },
    );
    const run = f.agent.prompt("read twice");
    f.close(call("first"));
    f.close(call("second"));
    f.finish();
    await first.promise;
    if (sequential) {
      expect(order).toEqual(["prepare:first", "execute:first"]);
    } else {
      await second.promise;
      expect(order).toEqual(["prepare:first", "prepare:second", "execute:first", "execute:second"]);
    }
    release.resolve();
    await run;
    expect(f.agent.state.messages.filter((m) => m.role === "toolResult").map((m) => m.toolCallId)).toEqual([
      "first",
      "second",
    ]);
  });
}
