import { expect, test } from "vitest";
import type { ToolView } from "../src/components/tool-presentation.ts";
import { questionPresentation } from "../src/components/user-question-presentation.ts";

const block: ToolView = {
  id: "m:0",
  messageId: "m",
  type: "tool",
  toolCallId: "q",
  name: "AskUserQuestion",
  argsText: JSON.stringify({ questions: [{ question: "去哪？" }, { question: "几天？" }] }),
  status: "completed",
  output: "",
};

test("uses structured answers independently of the tool's display text", () => {
  const presentation = questionPresentation({
    ...block,
    output: '回答：{"answers":{"去哪？":"上海"}}',
    questionAnswers: { answers: { "去哪？": "北京", "几天？": "2天, 3天" } },
  });
  expect(presentation.summary).toBe("2 个问题");
  expect(presentation.questions.map((question) => question.answer)).toEqual(["北京", "2天, 3天"]);
});

test("unanswered and interrupted questions keep the ZCode question record instead of raw tool data", () => {
  expect(questionPresentation({ ...block, questionAnswers: { answers: {} } }).summary).toBe(
    "未回答，已自动继续",
  );
  const failed = questionPresentation({
    ...block,
    status: "error",
    output: "Interrupted: side effects unknown; tool was not replayed.",
  });
  expect(failed.summary).toBe("2 个问题");
  expect(failed.questions.map((question) => question.answer)).toEqual(["未提供回答", "未提供回答"]);
  expect(questionPresentation({ ...block, status: "running" }).running).toBe(true);
});

test("tolerates incomplete streamed parameters and leaves skipped answers explicit", () => {
  expect(questionPresentation({ ...block, argsText: '{"questions":[' }).questions).toEqual([]);
  const presentation = questionPresentation({ ...block, questionAnswers: { answers: { "去哪？": "北京" } } });
  expect(presentation.questions[1].answer).toBe("未提供回答");
});

test("question text cannot pick up inherited object properties as an answer", () => {
  const argsText = JSON.stringify({ questions: [{ question: "__proto__" }, { question: "toString" }] });
  expect(questionPresentation({ ...block, argsText }).questions.map((question) => question.answer)).toEqual([
    "未提供回答",
    "未提供回答",
  ]);
  const questionAnswers = { answers: Object.fromEntries([["__proto__", "A"]]) };
  expect(questionPresentation({ ...block, argsText, questionAnswers }).questions[0].answer).toBe("A");
  expect(questionPresentation({ ...block, argsText, questionAnswers }).questions[1].answer).toBe(
    "未提供回答",
  );
});
