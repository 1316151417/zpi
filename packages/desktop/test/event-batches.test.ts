import { afterEach, expect, it, vi } from "vitest";
import type { DesktopEvent, DesktopEventEnvelope } from "zpi-ui";
import { emptySession, reduceSession } from "zpi-ui/projection";
import { EventBatcher } from "../src/main/event-batcher.ts";
import {
  coalesceSessionEvents,
  eventBatchIntervalMs,
  eventBatchMaxChars,
  eventBatchMaxEvents,
} from "../src/shared/event-batches.ts";

afterEach(() => vi.useRealTimers());
const envelope = (seq: number, event: DesktopEvent): DesktopEventEnvelope => ({
  sessionId: "session",
  runId: "run",
  seq,
  event,
});
const delta = (seq: number, text = "x") =>
  envelope(seq, {
    type: "block_delta",
    messageId: "message",
    contentIndex: 0,
    delta: text,
  });
const initial = [
  envelope(1, { type: "started", text: "hello", startedAt: 1, modelLabel: "fake" }),
  envelope(2, { type: "block_start", messageId: "message", contentIndex: 0, kind: "text", timestamp: 2 }),
];
const replay = (events: readonly DesktopEventEnvelope[]) =>
  events.reduce(reduceSession, emptySession("session"));

it("batches streamed events for one window and flushes lifecycle barriers without waiting", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const batcher = new EventBatcher(send);
  const stream = [delta(3, "a"), delta(4, "b"), delta(5, "c")];
  for (const event of stream) batcher.push(event);
  expect(send).not.toHaveBeenCalled();
  vi.advanceTimersByTime(eventBatchIntervalMs);
  expect(send).toHaveBeenCalledExactlyOnceWith(stream);
  batcher.push(delta(6));
  const settled = envelope(7, { type: "settled", endedAt: 2, status: "error", error: "failed" });
  batcher.push(settled);
  expect(send.mock.calls.slice(1)).toEqual([[[delta(6)]], [[settled]]]);
  vi.advanceTimersByTime(eventBatchIntervalMs);
  expect(send).toHaveBeenCalledTimes(3);
  batcher.close();
});

it("flushes at the count and content budgets and delivers oversized events alone without truncating", () => {
  vi.useFakeTimers();
  const delivered: DesktopEventEnvelope[][] = [];
  const batcher = new EventBatcher((events) => delivered.push(events));
  for (let i = 0; i < eventBatchMaxEvents; i++) batcher.push(delta(i + 1));
  expect(delivered).toHaveLength(1);
  expect(delivered[0]).toHaveLength(eventBatchMaxEvents);
  batcher.push(delta(300, "a".repeat(eventBatchMaxChars - 1)));
  batcher.push(delta(301, "bc"));
  expect(delivered).toHaveLength(2);
  const oversized = delta(302, "z".repeat(eventBatchMaxChars + 1));
  batcher.push(oversized);
  expect(delivered.slice(2)).toEqual([[delta(301, "bc")], [oversized]]);
  batcher.close();
});

it("clears pending content on navigation and releases its timer when closed", () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const batcher = new EventBatcher(send);
  batcher.push(delta(3));
  batcher.clear();
  vi.advanceTimersByTime(eventBatchIntervalMs);
  expect(send).not.toHaveBeenCalled();
  batcher.push(delta(4));
  batcher.close();
  batcher.push(delta(5));
  vi.advanceTimersByTime(eventBatchIntervalMs);
  expect(send).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("coalesces only fresh contiguous appends and preserves every snapshot/replay outcome", () => {
  const events = [...initial, delta(3, "a"), delta(4, "b"), delta(5, "c"), delta(6, "d")];
  expect(coalesceSessionEvents(events, () => 0)).toHaveLength(3);
  expect(events[2].event).toMatchObject({ delta: "a" });
  for (let boundary = 0; boundary <= events.length; boundary++) {
    const snapshot = replay(events.slice(0, boundary));
    const expected = events.reduce(reduceSession, snapshot);
    const combined = coalesceSessionEvents(events, () => snapshot.seq).reduce(reduceSession, snapshot);
    expect(combined).toEqual(expected);
  }
  const replayed = [...initial, delta(3, "a"), delta(3, "a"), delta(4, "b"), delta(5, "c")];
  expect(replay(coalesceSessionEvents(replayed, () => 0))).toEqual(replay(replayed));
  expect(replay(coalesceSessionEvents(replayed, () => 0)).runs[0].orderedBlocks[0]).toMatchObject({
    text: "abc",
  });
});

it("keeps activity, run, session, block, gap and lifecycle boundaries intact", () => {
  const first = delta(3, "a");
  const cases: DesktopEventEnvelope[] = [
    { ...delta(4), activityAt: 100 },
    { ...delta(4), sessionId: "other" },
    { ...delta(4), runId: "other" },
    envelope(4, { type: "block_delta", messageId: "other", contentIndex: 0, delta: "x" }),
    envelope(4, { type: "block_delta", messageId: "message", contentIndex: 1, delta: "x" }),
    delta(5),
    envelope(4, { type: "message_reset", messageId: "message" }),
    envelope(4, { type: "tool_update", toolCallId: "tool", output: "latest" }),
    envelope(4, { type: "question_changed", question: null }),
    envelope(4, { type: "settled", status: "completed", endedAt: 1 }),
  ];
  for (const next of cases) expect(coalesceSessionEvents([first, next], () => 0)).toEqual([first, next]);
  expect(coalesceSessionEvents([{ ...first, activityAt: 100 }, delta(4)], () => 0)).toHaveLength(2);
  expect(coalesceSessionEvents([first, delta(4)], () => Number.POSITIVE_INFINITY)).toEqual([first, delta(4)]);
});

it.each(["thinking", "tool"] as const)("preserves %s deltas across message and tool boundaries", (kind) => {
  const events = [
    initial[0],
    envelope(2, {
      type: "block_start",
      messageId: "message",
      contentIndex: 0,
      kind,
      timestamp: 2,
      ...(kind === "tool"
        ? { toolCall: { type: "toolCall" as const, id: "tool", name: "bash", arguments: {} } }
        : {}),
    }),
    delta(3, kind === "tool" ? '{"command":' : "思"),
    delta(4, kind === "tool" ? '"echo safe"}' : "考"),
    envelope(5, { type: "block_end", messageId: "message", contentIndex: 0, timestamp: 10 }),
    envelope(6, { type: "settled", status: "aborted", endedAt: 11 }),
  ];
  for (let end = 1; end <= events.length; end++)
    expect(replay(coalesceSessionEvents(events.slice(0, end), () => 0))).toEqual(
      replay(events.slice(0, end)),
    );
});
