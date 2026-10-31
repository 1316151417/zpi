import { expect, it, vi } from "vitest";
import type { AssistantMessage, Model } from "zpi-ai";
import { emptyAssistant, normalizeContext, streamSimple } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import type { DesktopEvent } from "zpi-ui";
import { emptySession, reduceSession } from "zpi-ui/projection";
import { fakeModel } from "../../../tests/fake-server.ts";
import { runPresentation } from "../../ui/src/components/process-presentation.ts";
import { projectEvent, restoreView } from "../src/main/projection.ts";

const model: Model = { ...fakeModel("https://local.example/v1"), api: "openai-responses" };
const summaries = ["检查记录", "检查覆盖范围", "汇总结果"];
const reasoning = {
  type: "reasoning",
  id: "rs_test",
  summary: summaries.map((text) => ({ type: "summary_text", text })),
  encrypted_content: "encrypted-reasoning",
};
const signature = JSON.stringify(reasoning);
const thinking = summaries.join("\n\n");
const tool = { type: "toolCall" as const, id: "call_test|fc_test", name: "bash", arguments: {} };

function restore(message: AssistantMessage) {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry("zpi.run", { phase: "start", runId: "r", text: "check", startedAt: 1 });
  manager.appendMessage(message);
  return restoreView("s", "task", manager.getEntries()).runs[0].orderedBlocks;
}

it("times a multi-summary reasoning item once through streaming, completion and history restore", async () => {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({ type: "started", text: "check", startedAt: 1, modelLabel: "fake" });
  const call = { type: "function_call", id: "fc_test", call_id: "call_test", name: "bash", arguments: "{}" };
  const wire = [
    { type: "response.output_item.added", item: { ...reasoning, summary: [] } },
    ...summaries.map((delta, summary_index) => ({
      type: "response.reasoning_summary_text.delta",
      item_id: reasoning.id,
      summary_index,
      delta,
    })),
    { type: "response.output_item.done", item: reasoning },
    { type: "response.output_item.done", item: call },
    {
      type: "response.completed",
      response: { id: "resp_test", status: "completed", output: [reasoning, call] },
    },
  ];
  const now = vi.spyOn(Date, "now").mockReturnValue(1000);
  try {
    const stream = streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: "fake",
      fetch: (async () =>
        new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        })) as typeof fetch,
    });
    let parts = 0;
    for await (const event of stream) {
      if (event.type === "start" || event.type === "done" || event.type === "error") continue;
      if (event.type === "thinking_delta") now.mockReturnValue(++parts * 10000);
      if (event.type === "thinking_end") now.mockReturnValue(38000);
      const projected = projectEvent(
        { type: "message_update", message: event.partial, assistantMessageEvent: event },
        "m",
      );
      if (projected) apply(projected);
      if (event.type === "thinking_delta") {
        expect(view.runs[0].orderedBlocks).toMatchObject([
          {
            type: "thinking",
            text: summaries.slice(0, parts).join("\n\n"),
            startedAt: 1000,
            streaming: true,
          },
        ]);
        expect(view.runs[0].orderedBlocks[0]).not.toHaveProperty("endedAt");
      }
    }
    const message = await stream.result();
    const final = projectEvent({ type: "message_end", message }, "m");
    if (final) apply(final);
    expect(message.stopReason).toBe("toolUse");
    expect(view.runs[0].orderedBlocks).toMatchObject([
      { type: "thinking", text: thinking, startedAt: 1000, endedAt: 38000, streaming: false },
      { type: "tool", toolCallId: tool.id, name: "bash" },
    ]);
    expect(restore(message)).toMatchObject([{ type: "thinking", text: thinking }, { type: "tool" }]);
  } finally {
    now.mockRestore();
  }
});

it("merges legacy summaries using their signature without changing the saved message or adjacent items", () => {
  const content: AssistantMessage["content"] = [
    ...summaries.map((text, index) => ({
      type: "thinking" as const,
      thinking: text,
      ...(index === 0 ? { thinkingSignature: signature } : {}),
    })),
    {
      type: "thinking",
      thinking: "另一个推理条目",
      thinkingSignature: JSON.stringify({ ...reasoning, id: "rs_next", summary: [] }),
    },
    tool,
  ];
  const message = { ...emptyAssistant(model), content };
  const before = structuredClone(message);
  expect(restore(message)).toMatchObject([
    { type: "thinking", text: thinking },
    { type: "thinking", text: "另一个推理条目" },
    { type: "tool", toolCallId: tool.id },
  ]);
  expect(message).toEqual(before);
});

it.each(["malformed", "mismatched", "separate-item", "other-api"])(
  "preserves historical thinking blocks when legacy summary matching is %s",
  (kind) => {
    const content: AssistantMessage["content"] = summaries.map((text, index) => ({
      type: "thinking",
      thinking: kind === "mismatched" && index === 1 ? "不同的内容" : text,
      ...(index === 0
        ? { thinkingSignature: kind === "malformed" ? "invalid JSON" : signature }
        : kind === "separate-item"
          ? { thinkingSignature: JSON.stringify({ ...reasoning, id: `rs_${index}` }) }
          : {}),
    }));
    const message = { ...emptyAssistant(kind === "other-api" ? fakeModel("") : model), content };
    expect(restore(message)).toMatchObject(
      content.map((block) => ({ type: "thinking", text: block.type === "thinking" ? block.thinking : "" })),
    );
  },
);

it("displays consecutive response items as one card while preserving streamed and stored reasoning", async () => {
  const items = [0, 1, 2].map((index) => ({
    ...reasoning,
    id: `rs_${index}`,
    summary: [0, 1].map((part) => ({ type: "summary_text", text: `item ${index} summary ${part}` })),
    encrypted_content: `encrypted-${index}`,
  }));
  const call = { type: "function_call", id: "fc_test", call_id: "call_test", name: "bash", arguments: "{}" };
  const wire = [
    ...items.flatMap((item) => [
      { type: "response.output_item.added", item: { ...item, summary: [] } },
      ...item.summary.map((part, summary_index) => ({
        type: "response.reasoning_summary_text.delta",
        item_id: item.id,
        summary_index,
        delta: part.text,
      })),
      { type: "response.output_item.done", item },
    ]),
    { type: "response.output_item.done", item: call },
    {
      type: "response.completed",
      response: { id: "resp_test", status: "completed", output: [...items, call] },
    },
  ];
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({ type: "started", text: "check", startedAt: 1, modelLabel: "fake" });
  const stream = streamSimple(model, normalizeContext({ messages: [] }), {
    apiKey: "fake",
    fetch: (async () =>
      new Response(wire.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
      })) as typeof fetch,
  });
  for await (const event of stream) {
    if (event.type === "start" || event.type === "done" || event.type === "error") continue;
    const projected = projectEvent(
      { type: "message_update", message: event.partial, assistantMessageEvent: event },
      "m",
    );
    if (projected) apply(projected);
    if (event.type === "thinking_delta") {
      const cards = runPresentation(view.runs[0]).process;
      expect(cards).toMatchObject([{ id: "m:0", type: "thinking", streaming: true }]);
      expect(cards[0].type !== "tool" && cards[0].text).toContain(event.delta);
    }
  }
  const message = await stream.result();
  const before = structuredClone(message);
  const final = projectEvent({ type: "message_end", message }, "m");
  if (final) apply(final);
  const expected = items.flatMap((item) => item.summary.map((part) => part.text)).join("\n\n");
  expect(runPresentation(view.runs[0]).process).toMatchObject([
    { id: "m:0", type: "thinking", text: expected, streaming: false },
    { type: "tool", toolCallId: tool.id },
  ]);
  const restored = restore(message);
  expect(restored).toHaveLength(4);
  expect(runPresentation({ ...view.runs[0], orderedBlocks: restored }).process).toMatchObject([
    { type: "thinking", text: expected },
    { type: "tool", toolCallId: tool.id },
  ]);
  expect(
    message.content
      .filter((block) => block.type === "thinking")
      .map((block) => JSON.parse(block.thinkingSignature ?? "{}")),
  ).toEqual(items);
  expect(view.runs[0].orderedBlocks).toHaveLength(4);
  expect(message).toEqual(before);
});
