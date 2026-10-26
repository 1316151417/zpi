import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { RunGroup } from "../src/components/Conversation.tsx";
import { emptySession, reduceSession } from "../src/reducer.ts";
import type { DesktopEvent, RunView } from "../src/types.ts";

function fixture() {
  let view = emptySession("s");
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
    return view.runs[0];
  };
  apply({ type: "started", text: "answer", startedAt: 1, modelLabel: "fake" });
  const failed = {
    ...emptyAssistant(fakeModel("")),
    stopReason: "error" as const,
    errorMessage: "overloaded",
    content: [
      { type: "thinking" as const, thinking: "partial reasoning" },
      { type: "text" as const, text: "partial reply" },
    ],
  };
  apply({ type: "message_end", messageId: "failed", message: failed });
  return { apply };
}

const render = (run: RunView, blocks: Record<string, boolean> = {}) =>
  renderToStaticMarkup(
    createElement(RunGroup, {
      run,
      onLink: () => {},
      expanded: true,
      onToggle: () => {},
      blocks,
      onBlockToggle: () => {},
    }),
  );

it.each(["retry", "replacement"])(
  "folds the failed attempt on %s without hiding the new reply",
  (trigger) => {
    const { apply } = fixture();
    const run = apply(
      trigger === "retry"
        ? {
            type: "model_retry",
            status: { attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: null },
          }
        : { type: "message_start", messageId: "next", role: "assistant" },
    );
    expect(run.orderedBlocks).toMatchObject([
      { id: "failed:0", interrupted: true, streaming: false },
      { id: "failed:1", interrupted: true, streaming: false },
    ]);
    expect(run.finalAnswerBlockIds).toEqual([]);
    apply({ type: "block_start", messageId: "next", contentIndex: 0, kind: "text" });
    const streaming = apply({ type: "block_delta", messageId: "next", contentIndex: 0, delta: "new reply" });
    const markup = render(streaming);
    expect(markup).toContain("回复已中断");
    expect(markup).toContain("思考已中断");
    expect(markup).not.toContain("partial reply");
    expect(markup).toContain("new reply");
    expect(render(streaming, { "failed:1": true })).toContain("partial reply");
    apply({
      type: "message_end",
      messageId: "next",
      message: { ...emptyAssistant(fakeModel("")), content: [{ type: "text", text: "new reply" }] },
    });
    const completed = apply({ type: "settled", status: "completed", endedAt: 10 });
    expect(completed.finalAnswerBlockIds).toEqual(["next:0"]);
    expect(completed.orderedBlocks[1]).toMatchObject({ interrupted: true, text: "partial reply" });
  },
);

it("preserves the partial answer when retry is exhausted or the user stops before replacement", () => {
  for (const status of ["error", "aborted"] as const) {
    const { apply } = fixture();
    apply({
      type: "model_retry",
      status: { attempt: 1, maxRetries: 10, retryDelayMs: 2000, errorStatus: null },
    });
    const run = apply({ type: "settled", status, error: "overloaded", endedAt: 10 });
    expect(run.orderedBlocks.every((block) => block.type === "tool" || !block.interrupted)).toBe(true);
    expect(render(run)).toContain("partial reply");
    expect(run.failedMessageId).toBeUndefined();
  }
});
