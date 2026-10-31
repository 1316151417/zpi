import { expect, it } from "vitest";
import {
  reasoningDuration,
  reasoningSummary,
  runPresentation,
} from "../src/components/process-presentation.ts";
import type { RunView, ViewBlock } from "../src/types.ts";

const text = (id: string, type: "thinking" | "text", value = id): Exclude<ViewBlock, { type: "tool" }> => ({
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

it.each(["", " \n\t"])("omits empty prose (%j) after the final answer", (value) => {
  const answer = text("answer", "text");
  const blocks = [tool, answer, text("empty-thought", "thinking", ""), text("empty", "text", value)];
  expect(runPresentation(run(blocks, { finalAnswerBlockIds: [answer.id] }))).toEqual({
    process: [tool],
    answer,
    defaultOpen: false,
  });
});

it("keeps work open when the only final prose is empty", () => {
  const blocks = [text("intro", "text"), tool, text("empty", "text", "")];
  expect(runPresentation(run(blocks, { finalAnswerBlockIds: ["empty"] }))).toEqual({
    process: blocks.slice(0, -1),
    answer: undefined,
    defaultOpen: true,
  });
});

it("folds trailing reasoning into completed work while keeping the final prose outside", () => {
  const answer = text("answer", "text");
  const thought = text("follow-up", "thinking", "Awaiting user input");
  const blocks = [tool, answer, thought, text("empty", "text", "")];
  const view = run(blocks, { finalAnswerBlockIds: [answer.id] });
  expect(runPresentation(view)).toEqual({
    process: [tool, thought],
    answer,
    defaultOpen: false,
  });
  expect(runPresentation({ ...view, status: "running" })).toEqual({
    process: [tool, answer, thought],
    answer: undefined,
    defaultOpen: true,
  });
  expect(view.orderedBlocks).toEqual(blocks);
});

it("does not extract earlier prose across a trailing tool call and reasoning", () => {
  const blocks = [text("earlier", "text"), tool, text("follow-up", "thinking")];
  expect(runPresentation(run(blocks))).toEqual({
    process: blocks,
    answer: undefined,
    defaultOpen: true,
  });
});

it("keeps reasoning-only runs visible", () => {
  const blocks = [text("thought", "thinking")];
  expect(runPresentation(run(blocks))).toEqual({ process: blocks, answer: undefined, defaultOpen: true });
});

it("merges adjacent reasoning for display without changing the source blocks", () => {
  const blocks = [text("first", "thinking"), text("second", "thinking"), text("third", "thinking")];
  const before = structuredClone(blocks);
  blocks.forEach(Object.freeze);
  Object.freeze(blocks);
  expect(runPresentation(run(blocks)).process).toMatchObject([
    { id: "first", messageId: "message", type: "thinking", text: "first\n\nsecond\n\nthird" },
  ]);
  expect(blocks).toEqual(before);
});

it.each([
  ["prose", text("prose", "text")],
  ["empty prose", text("empty", "text", "")],
  ["tool", tool],
  ["unfinished tool", { ...tool, name: "bash", status: "preparing" as const, argsText: "" }],
  ["another response", { ...text("other", "thinking"), messageId: "other-message" }],
])("keeps reasoning separate across %s", (_, boundary) => {
  const view = run([text("first", "thinking"), boundary, text("last", "thinking")], { status: "running" });
  expect(
    runPresentation(view)
      .process.filter((block) => block.type === "thinking")
      .map((block) => block.id),
  ).toEqual(boundary.type === "thinking" ? ["first", "other", "last"] : ["first", "last"]);
});

it("keeps a merged card streaming through empty items and measures the whole interval", () => {
  const first = { ...text("first", "thinking"), startedAt: 1000, endedAt: 2500, streaming: false };
  const next = { ...text("next", "thinking", ""), startedAt: 3000, streaming: true };
  const active = runPresentation(run([first, next], { status: "running" })).process;
  expect(active).toMatchObject([{ id: "first", text: "first", startedAt: 1000, streaming: true }]);
  expect(active[0]).not.toHaveProperty("endedAt", expect.any(Number));
  const completed = runPresentation(run([first, { ...next, text: "next", streaming: false, endedAt: 7000 }]));
  expect(completed.process).toMatchObject([
    { id: "first", text: "first\n\nnext", startedAt: 1000, endedAt: 7000, streaming: false },
  ]);
});

it("retains interruption state and unknown historical timing when merging", () => {
  const blocks = [text("first", "thinking"), { ...text("last", "thinking"), interrupted: true }];
  const [merged] = runPresentation(run(blocks, { status: "interrupted" })).process;
  expect(merged).toMatchObject({ id: "first", text: "first\n\nlast", interrupted: true });
  expect(merged).not.toHaveProperty("startedAt");
  expect(merged).not.toHaveProperty("endedAt", expect.any(Number));
});

it("preserves compaction anchors and never merges across a compaction", () => {
  const blocks = ["first", "second", "third", "fourth"].map((id) => text(id, "thinking"));
  const view = run(blocks, {
    compactions: [{ id: "compact", status: "completed", origin: "auto", afterBlockId: "second" }],
  });
  expect(runPresentation(view).process).toMatchObject([
    { id: "first", text: "first\n\nsecond", lastBlockId: "second" },
    { id: "third", text: "third\n\nfourth", lastBlockId: "fourth" },
  ]);
});

it("does not merge reasoning across a final answer extracted from completed work", () => {
  const answer = text("answer", "text");
  const view = run([text("before", "thinking"), answer, text("after", "thinking")]);
  expect(runPresentation(view)).toEqual({
    process: [view.orderedBlocks[0], view.orderedBlocks[2]],
    answer,
    defaultOpen: false,
  });
});
