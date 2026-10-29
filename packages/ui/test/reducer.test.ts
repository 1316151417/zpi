import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { emptySession, mergeHistory, progressSummary, reduceSession } from "../src/reducer.ts";
import type { DesktopEvent, RunView, SessionView } from "../src/types.ts";

it("merges history in order without mutating pages or copying unchanged runs", () => {
  const run = (runId: string, text: string): RunView => ({
    runId,
    status: "completed",
    startedAt: 1,
    userMessage: `input ${runId}`,
    orderedBlocks: [{ type: "text", id: text, messageId: text, text, streaming: false }],
    finalAnswerBlockIds: [text],
  });
  const first = run("first", "first answer");
  const overlap = { ...run("overlap", "earlier answer"), fileReferences: ["file.ts"] };
  const continuation = { ...run("overlap", "latest answer"), historyContinuation: true, userMessage: "" };
  const last = run("last", "last answer");
  const older = { ...emptySession("s"), runs: [first, overlap] };
  const newer = { ...emptySession("s"), seq: 42, runs: [continuation, last] };
  const original = structuredClone({ older, newer });

  const merged = mergeHistory(older, newer);
  expect(merged.seq).toBe(42);
  expect(merged.runs.map((entry) => entry.runId)).toEqual(["first", "overlap", "last"]);
  expect(merged.runs[0]).toBe(first);
  expect(merged.runs[2]).toBe(last);
  expect(merged.runs[1]).toMatchObject({
    userMessage: overlap.userMessage,
    fileReferences: overlap.fileReferences,
    historyContinuation: undefined,
    orderedBlocks: [...overlap.orderedBlocks, ...continuation.orderedBlocks],
    finalAnswerBlockIds: continuation.finalAnswerBlockIds,
  });
  expect({ older, newer }).toEqual(original);
  expect(mergeHistory(emptySession("s"), newer)).toEqual(newer);
  expect(mergeHistory(older, emptySession("s")).runs).toEqual(older.runs);

  // Repeated chunks for a newly encountered run must update the same slot.
  const updated = { ...last, orderedBlocks: [{ ...last.orderedBlocks[0], text: "updated answer" }] };
  expect(mergeHistory(older, { ...newer, runs: [last, updated] }).runs).toEqual([
    first,
    overlap,
    { ...updated, compactions: [], historyContinuation: undefined },
  ]);
});

it("retains a tool error completed during model streaming when the final assistant replaces its blocks", () => {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  const call = { type: "toolCall" as const, id: "read", name: "read", arguments: { path: "missing" } };
  apply({ type: "started", text: "read", startedAt: 1, modelLabel: "fake" });
  apply({ type: "block_start", messageId: "m", contentIndex: 0, kind: "tool", toolCall: call });
  apply({ type: "tool_start", toolCallId: call.id, name: call.name, argsText: "{}" });
  apply({
    type: "tool_end",
    toolCallId: call.id,
    output: "missing file",
    isError: true,
    hasFileChange: false,
  });
  apply({
    type: "message_end",
    messageId: "m",
    message: { ...emptyAssistant(fakeModel("")), content: [call] },
  });
  expect(view.runs[0].orderedBlocks[0]).toMatchObject({
    status: "error",
    isError: true,
    output: "missing file",
  });
});

it("keeps retry state in live snapshots, resets only the failed message and clears retries on settlement", () => {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({ type: "started", text: "hi", startedAt: 1, modelLabel: "fake" });
  for (const messageId of ["earlier", "failed"]) {
    apply({ type: "block_start", messageId, contentIndex: 0, kind: "text" });
    apply({ type: "block_delta", messageId, contentIndex: 0, delta: messageId });
  }
  const status = { attempt: 3, maxRetries: 10, retryDelayMs: 120_000, errorStatus: 429 };
  apply({ type: "model_retry", status });
  expect(view.runs[0]).toMatchObject({ status: "running", apiRetry: status });
  expect(structuredClone(view).runs[0].apiRetry).toEqual(status);
  apply({ type: "message_reset", messageId: "failed" });
  expect(view.runs[0].orderedBlocks).toMatchObject([{ messageId: "earlier", text: "earlier" }]);
  expect(view.runs[0].finalAnswerBlockIds).toEqual(["earlier:0"]);
  apply({ type: "settled", status: "aborted", endedAt: 100 });
  expect(view.runs[0].apiRetry).toBeNull();
  apply({ type: "model_retry", status });
  expect(view.runs[0].apiRetry).toBeNull();
});

it.each(["completed", "error", "aborted", "interrupted"] as const)(
  "clears model waiting on %s and rejects late or cross-run waiting events",
  (status) => {
    let view = emptySession("s");
    let seq = 0;
    const apply = (event: DesktopEvent, runId = "r") => {
      view = reduceSession(view, { sessionId: "s", runId, seq: ++seq, event });
    };
    const waiting = { phase: "first_response" as const, startedAt: 10 };
    apply({ type: "started", text: "hello", startedAt: 1, modelLabel: "fake" });
    apply({ type: "model_wait", status: waiting });
    expect(structuredClone(view).runs[0].modelWait).toEqual(waiting);
    apply({ type: "model_wait", status: null });
    expect(view.runs[0].modelWait).toBeNull();
    apply({ type: "model_wait", status: waiting });
    apply({ type: "settled", status, endedAt: 100 });
    expect(view.runs[0].modelWait).toBeNull();
    apply({ type: "started", text: "next", startedAt: 200, modelLabel: "fake" }, "next");
    apply({ type: "model_wait", status: { phase: "stream", startedAt: 210 } }, "next");
    apply({ type: "model_wait", status: waiting });
    expect(view.runs[0]).toMatchObject({ status, modelWait: null });
    expect(view.runs[1].modelWait).toEqual({ phase: "stream", startedAt: 210 });
    apply({ type: "model_wait", status: waiting }, "unknown");
    expect(view.runs).toHaveLength(2);
  },
);

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

it("clears transient errors on retry and successful continuation while retaining partial history", () => {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: import("../src/types.ts").DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({ type: "started", text: "retry", startedAt: 1, modelLabel: "fake" });
  const failed = {
    ...emptyAssistant(fakeModel("")),
    content: [{ type: "text" as const, text: "partial" }],
    stopReason: "error" as const,
    errorMessage: "503 busy",
  };
  apply({ type: "message_end", messageId: "r:1", message: failed });
  expect(view.runs[0].error).toBe("503 busy");
  apply({ type: "model_retry", status: { attempt: 1, maxRetries: 3, retryDelayMs: 2000, errorStatus: 503 } });
  expect(view.runs[0].error).toBeUndefined();
  apply({
    type: "message_end",
    messageId: "r:2",
    message: {
      ...failed,
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "recovered" }],
    },
  });
  expect(view.runs[0].orderedBlocks.map((block) => block.type !== "tool" && block.text)).toEqual([
    "partial",
    "recovered",
  ]);
  expect(view.runs[0].finalAnswerBlockIds).toEqual(["r:2:0"]);
  expect(view.runs[0].error).toBeUndefined();
});
