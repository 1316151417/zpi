import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "zpi-agent";
import { createAssistantMessageEventStream, emptyAssistant, type Message } from "zpi-ai";
import { deferred, fakeModel } from "../../../tests/fake-server.ts";

const model = fakeModel("");
const mail = (): AgentMessage => ({ role: "user", content: "Worker findings", timestamp: 1 });

it.each(["thinking", "commentary", "partial_answer"] as const)(
  "continues the same run with mail at a completed %s boundary before the stream finishes",
  async (kind) => {
    const inbox: AgentMessage[] = [];
    const inputs: Message[][] = [];
    const signals: AbortSignal[] = [];
    const streamFn: StreamFn = (_, context, options) => {
      inputs.push(structuredClone(context.messages));
      signals.push(options?.signal as AbortSignal);
      const events = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      if (inputs.length === 1) {
        message.content =
          kind === "thinking"
            ? [{ type: "thinking", thinking: "Working", thinkingSignature: "closed signature" }]
            : [{ type: "text", text: "Working", phase: kind }];
        events.push({ type: "start", partial: message });
        events.push({
          type: kind === "thinking" ? "thinking_end" : "text_end",
          contentIndex: 0,
          content: "Working",
          partial: message,
        });
        // Buffered future declarations must not run or enter history after preemption.
        message.content.push({ type: "toolCall", id: "future", name: "unreachable", arguments: {} });
        events.push({
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: message.content[1] as never,
          partial: message,
        });
      } else {
        message.content = [{ type: "text", text: "Combined final answer" }];
        events.end(message);
      }
      return events;
    };
    const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
    let runs = 0;
    agent.subscribe((event) => {
      if (event.type === "agent_start") runs++;
      if (
        event.type === "message_update" &&
        ["thinking_end", "text_end"].includes(event.assistantMessageEvent.type)
      )
        inbox.push(mail());
    });
    await agent.prompt("Research");
    expect(runs).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1]).toContainEqual(mail());
    expect(JSON.stringify(inputs[1])).not.toContain("unreachable");
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    if (kind === "thinking") expect(JSON.stringify(inputs[1])).toContain("closed signature");
  },
);

it.each(["final_answer", undefined] as const)(
  "retains mail after final text with phase %s",
  async (phase) => {
    const inbox: AgentMessage[] = [];
    const streamFn = vi.fn<StreamFn>(() => {
      const events = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      message.content = [{ type: "text", text: "Final", ...(phase ? { phase } : {}) }];
      events.push({ type: "start", partial: message });
      events.push({ type: "text_end", contentIndex: 0, content: "Final", partial: message });
      events.end(message);
      return events;
    });
    const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
    agent.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end")
        inbox.push(mail());
    });
    await agent.prompt("Finish");
    expect(streamFn).toHaveBeenCalledTimes(1);
    expect(inbox).toEqual([mail()]);
  },
);

it("preserves completed tool results and drains a live tool without cancelling or repeating it", async () => {
  const inbox: AgentMessage[] = [];
  const boundary = deferred();
  const releaseTool = deferred();
  const inputs: Message[][] = [];
  let toolAborted = false;
  const execute = vi.fn(async (_id, _args, signal) => {
    signal?.addEventListener("abort", () => {
      toolAborted = true;
    });
    await releaseTool.promise;
    return { content: [{ type: "text" as const, text: "Tool findings" }], details: undefined };
  });
  const tool: AgentTool = {
    name: "search",
    label: "Search",
    description: "Search",
    parameters: Type.Object({}),
    metadata: { readOnly: true, concurrentSafe: true, sideEffectScope: "none" },
    execute,
  };
  const streamFn: StreamFn = (_, context) => {
    inputs.push(structuredClone(context.messages));
    const events = createAssistantMessageEventStream();
    const message = emptyAssistant(model);
    if (inputs.length === 1) {
      const call = { type: "toolCall" as const, id: "once", name: "search", arguments: {} };
      message.content = [call, { type: "text", text: "Working", phase: "commentary" }];
      events.push({ type: "start", partial: message });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial: message });
      events.push({ type: "text_end", contentIndex: 1, content: "Working", partial: message });
    } else {
      message.content = [{ type: "text", text: "Final" }];
      events.end(message);
    }
    return events;
  };
  const agent = new Agent({
    initialState: { model, tools: [tool] },
    streamFn,
    getPendingMessages: () => inbox.splice(0),
  });
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end") {
      inbox.push(mail());
      boundary.resolve();
    }
  });
  const running = agent.prompt("Work");
  await boundary.promise;
  expect(inputs).toHaveLength(1);
  releaseTool.resolve();
  await running;
  expect(toolAborted).toBe(false);
  expect(execute).toHaveBeenCalledTimes(1);
  expect(inputs[1].filter((message) => message.role === "toolResult")).toHaveLength(1);
  expect(inputs[1]).toContainEqual(mail());
});

it.each(["error", "aborted"] as const)("does not consume pending mail on %s", async (stopReason) => {
  const inbox: AgentMessage[] = [];
  const streamFn: StreamFn = () => {
    const events = createAssistantMessageEventStream();
    const message = emptyAssistant(model);
    message.stopReason = stopReason;
    inbox.push(mail());
    events.end(message);
    return events;
  };
  const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
  await agent.prompt("Work");
  expect(inbox).toEqual([mail()]);
});

it("keeps mail deferred if reasoning follows a completed final answer", async () => {
  const inbox: AgentMessage[] = [];
  const streamFn = vi.fn<StreamFn>(() => {
    const stream = createAssistantMessageEventStream();
    const message = emptyAssistant(model);
    message.content = [
      { type: "text", text: "Final answer", phase: "final_answer" },
      { type: "thinking", thinking: "Trailing reasoning" },
    ];
    stream.push({ type: "start", partial: message });
    stream.push({ type: "text_end", contentIndex: 0, content: "Final answer", partial: message });
    stream.push({ type: "thinking_end", contentIndex: 1, content: "Trailing reasoning", partial: message });
    stream.end(message);
    return stream;
  });
  const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end")
      inbox.push(mail());
  });
  await agent.prompt("Finish");
  expect(streamFn).toHaveBeenCalledTimes(1);
  expect(inbox).toEqual([mail()]);
});

it("accepts mail at model completion when a commentary step closed before delivery", async () => {
  const inbox: AgentMessage[] = [];
  const inputs: Message[][] = [];
  const streamFn: StreamFn = (_, context) => {
    inputs.push(structuredClone(context.messages));
    const stream = createAssistantMessageEventStream();
    const message = emptyAssistant(model);
    message.content =
      inputs.length === 1
        ? [{ type: "text", text: "Working", phase: "commentary" }]
        : [{ type: "text", text: "Final" }];
    stream.end(message);
    return stream;
  };
  const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
  agent.subscribe((event) => {
    if (event.type === "turn_end" && inputs.length === 1) inbox.push(mail());
  });
  await agent.prompt("Work");
  expect(inputs).toHaveLength(2);
  expect(inputs[1]).toContainEqual(mail());
});
