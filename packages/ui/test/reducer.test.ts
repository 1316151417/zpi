import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { emptySession, progressSummary, reduceSession } from "../src/reducer.ts";
import type { DesktopEvent, SessionView } from "../src/types.ts";

it("authoritative final replaces streamed content, tool updates replace snapshots, errors stay visible", () => {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({ type: "started", text: "hi", startedAt: 1, modelLabel: "fake" });
  apply({ type: "block_start", messageId: "m1", contentIndex: 0, kind: "text" });
  apply({ type: "block_delta", messageId: "m1", contentIndex: 0, delta: "intermediate" });
  apply({
    type: "block_start",
    messageId: "m1",
    contentIndex: 1,
    kind: "tool",
    toolCall: { type: "toolCall", id: "t", name: "bash", arguments: {} },
  });
  expect(view.runs[0].finalAnswerBlockIds).toEqual([]);
  apply({ type: "tool_update", toolCallId: "t", output: "one" });
  apply({ type: "tool_update", toolCallId: "t", output: "one two" });
  expect(view.runs[0].orderedBlocks[1]).toMatchObject({ output: "one two" });
  apply({ type: "block_start", messageId: "thought", contentIndex: 0, kind: "thinking", timestamp: 1000 });
  apply({ type: "block_end", messageId: "thought", contentIndex: 0, timestamp: 13000 });
  apply({
    type: "message_end",
    messageId: "thought",
    message: { ...emptyAssistant(fakeModel("")), content: [{ type: "thinking", thinking: "finished" }] },
  });
  expect(view.runs[0].orderedBlocks.find((block) => block.id === "thought:0")).toMatchObject({
    startedAt: 1000,
    endedAt: 13000,
    streaming: false,
  });
  apply({
    type: "message_end",
    messageId: "historic",
    message: { ...emptyAssistant(fakeModel("")), content: [{ type: "thinking", thinking: "old" }] },
  });
  expect(view.runs[0].orderedBlocks.find((block) => block.id === "historic:0")).not.toHaveProperty(
    "startedAt",
  );
  apply({ type: "block_start", messageId: "m2", contentIndex: 0, kind: "text" });
  apply({ type: "block_delta", messageId: "m2", contentIndex: 0, delta: "final" });
  const message = emptyAssistant(fakeModel(""));
  message.content = [{ type: "text", text: "final answer" }];
  apply({ type: "message_end", messageId: "m2", message });
  apply({ type: "settled", status: "error", endedAt: 2001, error: "disk full" });
  expect(view.runs[0].orderedBlocks.at(-1)).toMatchObject({ text: "final answer" });
  expect(view.runs[0].error).toBe("disk full");
  expect(progressSummary(view.runs[0])).toContain("运行失败");
  const same: SessionView = reduceSession(view, {
    sessionId: "s",
    runId: "r",
    seq,
    event: { type: "settled", status: "completed", endedAt: 0 },
  });
  expect(same).toBe(view);
});
