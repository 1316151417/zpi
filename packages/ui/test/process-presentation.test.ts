import { expect, it } from "vitest";
import { runPresentation } from "../src/components/process-presentation.ts";
import type { RunView, ViewBlock } from "../src/types.ts";

const text = (id: string, type: "thinking" | "text", value = id): ViewBlock => ({
  id,
  messageId: "message",
  type,
  text: value,
});
const tool: ViewBlock = {
  id: "tool",
  messageId: "message",
  type: "tool",
  toolCallId: "read",
  name: "read",
  argsText: '{"path":"README.md"}',
  status: "completed",
  output: "# Test project",
};
const run = (blocks: ViewBlock[], overrides: Partial<RunView> = {}): RunView => ({
  runId: "run",
  status: "completed",
  userMessage: "test",
  orderedBlocks: blocks,
  finalAnswerBlockIds: blocks.filter((block) => block.type === "text").map((block) => block.id),
  startedAt: 0,
  ...overrides,
});

it("keeps all running prose in the work stream, including snapshots with no streaming reasoning", () => {
  const blocks = [text("thought", "thinking"), text("intro", "text"), tool, text("answer", "text")];
  const view = run(blocks, { status: "running" });
  expect(runPresentation(view)).toEqual({ process: blocks, answer: undefined, defaultOpen: true });
  expect(view.orderedBlocks).toEqual(blocks);
  expect(view.finalAnswerBlockIds).toEqual(["intro", "answer"]);
});

it("moves only the last completed prose segment outside history and keeps earlier prose in order", () => {
  const blocks = [
    text("intro", "text"),
    tool,
    text("thought", "thinking"),
    text("explanation", "text"),
    text("thought2", "thinking"),
    text("answer", "text"),
  ];
  expect(runPresentation(run(blocks))).toEqual({
    process: blocks.slice(0, -1),
    answer: blocks.at(-1),
    defaultOpen: false,
  });
});

it.each(["aborted", "error", "interrupted"] as const)(
  "keeps %s context open beside partial answers",
  (status) => {
    const blocks = [text("intro", "text"), tool, text("partial", "text")];
    expect(runPresentation(run(blocks, { status }))).toEqual({
      process: blocks.slice(0, -1),
      answer: blocks.at(-1),
      defaultOpen: true,
    });
  },
);

it("keeps history open when the model ends without a final prose answer", () => {
  const blocks = [text("intro", "text"), tool, text("thought", "thinking")];
  expect(runPresentation(run(blocks, { finalAnswerBlockIds: [] }))).toEqual({
    process: blocks,
    answer: undefined,
    defaultOpen: true,
  });
});

it("omits empty reasoning without hiding the final prose or creating an empty work container", () => {
  const answer = text("answer", "text");
  expect(runPresentation(run([text("empty", "thinking", " \n "), answer]))).toEqual({
    process: [],
    answer,
    defaultOpen: false,
  });
});
