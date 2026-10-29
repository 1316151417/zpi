import { setImmediate } from "node:timers/promises";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import { Agent, type AgentMessage, type AgentTool, type StreamFn } from "zpi-agent";
import { createAssistantMessageEventStream, emptyAssistant, type Message } from "zpi-ai";
import { deferred, fakeModel } from "../../../tests/fake-server.ts";

const model = fakeModel("");
const mail = (content = "Worker findings"): AgentMessage => ({ role: "user", content, timestamp: 1 });

it.each(["thinking", "commentary", "partial_answer", "final_answer", undefined] as const)(
  "batches mail after the complete response, not at a %s item boundary",
  async (kind) => {
    const inbox: AgentMessage[] = [];
    const inputs: Message[][] = [];
    const signals: AbortSignal[] = [];
    const boundary = deferred();
    const first = createAssistantMessageEventStream();
    const firstMessage = emptyAssistant(model);
    const queued = [mail(), mail("Worker verification")];
    const streamFn: StreamFn = (_, context, options) => {
      inputs.push(structuredClone(context.messages));
      signals.push(options?.signal as AbortSignal);
      if (inputs.length === 1) {
        firstMessage.content =
          kind === "thinking"
            ? [{ type: "thinking", thinking: "", thinkingSignature: "closed signature" }]
            : [{ type: "text", text: "Working", ...(kind ? { phase: kind } : {}) }];
        first.push({ type: "start", partial: firstMessage });
        first.push({
          type: kind === "thinking" ? "thinking_end" : "text_end",
          contentIndex: 0,
          content: kind === "thinking" ? "" : "Working",
          partial: firstMessage,
        });
        return first;
      }
      const events = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      message.content = [{ type: "text", text: "Combined final answer" }];
      events.end(message);
      return events;
    };
    const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
    let runs = 0;
    agent.subscribe((event) => {
      if (event.type === "agent_start") runs++;
      if (
        event.type === "message_update" &&
        ["thinking_end", "text_end"].includes(event.assistantMessageEvent.type)
      ) {
        inbox.push(...queued);
        boundary.resolve();
      }
    });
    const running = agent.prompt("Research");
    await boundary.promise;
    await setImmediate();
    expect(signals[0].aborted).toBe(false);
    expect(inputs).toHaveLength(1);
    expect(inbox).toEqual(queued);
    firstMessage.content.push({ type: "text", text: "Completed response tail" });
    first.end(firstMessage);
    await running;
    expect(runs).toBe(1);
    expect(inputs).toHaveLength(2);
    expect(inputs[1].slice(-2)).toEqual(queued);
    expect(JSON.stringify(inputs[1])).toContain("Completed response tail");
    expect(inbox).toEqual([]);
    expect(signals[0].aborted).toBe(false);
    expect(signals[1].aborted).toBe(false);
    if (kind === "thinking") expect(JSON.stringify(inputs[1])).toContain("closed signature");
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
      message.stopReason = "toolUse";
      events.end(message);
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
  expect(inputs[1].at(-1)).toEqual(mail());
});

it.each(["error", "aborted", "length"] as const)(
  "does not consume pending mail on %s",
  async (stopReason) => {
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
  },
);

it("includes mail after a final answer followed by trailing reasoning completes", async () => {
  const inbox: AgentMessage[] = [];
  const streamFn = vi.fn<StreamFn>(() => {
    const stream = createAssistantMessageEventStream();
    const message = emptyAssistant(model);
    message.content = [
      { type: "text", text: "Final answer", phase: "final_answer" },
      { type: "thinking", thinking: "Trailing reasoning" },
    ];
    if (streamFn.mock.calls.length === 1) {
      stream.push({ type: "start", partial: message });
      stream.push({ type: "text_end", contentIndex: 0, content: "Final answer", partial: message });
      stream.push({ type: "thinking_end", contentIndex: 1, content: "Trailing reasoning", partial: message });
    }
    stream.end(message);
    return stream;
  });
  const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
  agent.subscribe((event) => {
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_end")
      inbox.push(mail());
  });
  await agent.prompt("Finish");
  expect(streamFn).toHaveBeenCalledTimes(2);
  expect(inbox).toEqual([]);
  expect(streamFn.mock.calls[1][1].messages.at(-1)).toEqual(mail());
});

it("user cancellation still aborts an active response and retains pending mail", async () => {
  const inbox: AgentMessage[] = [];
  const started = deferred();
  let signal: AbortSignal | undefined;
  const streamFn = vi.fn<StreamFn>((_, _context, options) => {
    signal = options?.signal;
    const stream = createAssistantMessageEventStream();
    const message = emptyAssistant(model);
    stream.push({ type: "start", partial: message });
    signal?.addEventListener("abort", () => {
      message.stopReason = "aborted";
      stream.end(message);
    });
    started.resolve();
    return stream;
  });
  const agent = new Agent({ initialState: { model }, streamFn, getPendingMessages: () => inbox.splice(0) });
  const running = agent.prompt("Work");
  await started.promise;
  inbox.push(mail());
  agent.abort();
  await running;
  expect(signal?.aborted).toBe(true);
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
