import { expect, it } from "vitest";
import { conversationRunPartition, isNavigableRun } from "../src/conversation-run-partition.ts";
import { reduceSession } from "../src/reducer.ts";
import type { RunView, SessionView } from "../src/types.ts";

it("reuses the complete 5000-run history across live updates, and invalidates it for historical edits", () => {
  const runs: RunView[] = Array.from({ length: 5001 }, (_, index) => ({
    runId: `run-${index}`,
    status: index === 5000 ? "running" : "completed",
    userMessage: `question ${index}`,
    startedAt: 1,
    orderedBlocks: [],
    finalAnswerBlockIds: [],
  }));
  let view: SessionView = { sessionId: "s", title: "test", seq: 0, runs };
  const history = conversationRunPartition(view.runs).history;
  expect(history.filter(isNavigableRun)).toHaveLength(5000);
  for (let seq = 1; seq <= 120; seq++) {
    view = reduceSession(view, {
      sessionId: "s",
      runId: "run-5000",
      seq,
      event: { type: "notice", text: String(seq) },
    });
    expect(conversationRunPartition(view.runs).history).toBe(history);
    expect(conversationRunPartition(view.runs).tail?.notice).toBe(String(seq));
  }
  view = reduceSession(view, {
    sessionId: "s",
    runId: "run-0",
    seq: 121,
    event: { type: "notice", text: "updated history" },
  });
  expect(conversationRunPartition(view.runs).history).not.toBe(history);
  expect(conversationRunPartition(view.runs).history[0]?.notice).toBe("updated history");
});
