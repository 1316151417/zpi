import { expect, it } from "vitest";
import {
  reasoningDuration,
  reasoningSummary,
  runPresentation,
} from "../src/components/process-presentation.ts";
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

it.each([
  ["首行\n末行\n\n", "末行"],
  ["首行\r\n末行\r\n \r\n", "末行"],
  ["首行\r末行", "末行"],
  [" \n\t", ""],
])("uses ZCode's last nonempty streaming line for %j", (value, expected) => {
  expect(reasoningSummary(value)).toBe(expected);
});

it.each([
  [undefined, "持续了几秒"],
  [0, "持续了 1 秒"],
  [1000, "持续了 1 秒"],
  [1001, "持续了 2 秒"],
  [61_100, "持续了 62 秒"],
])("formats ZCode's reasoning duration for %j ms", (value, expected) => {
  expect(reasoningDuration(value)).toBe(expected);
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
