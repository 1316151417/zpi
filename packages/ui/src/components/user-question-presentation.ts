// Adapted from ZCode's askUserQuestion answer presentation (Apache-2.0).
import { type ToolView, toolInput } from "./tool-presentation.ts";

export function questionPresentation(block: ToolView) {
  const input = toolInput(block);
  const questions = (Array.isArray(input.questions) ? input.questions : [])
    .filter((value): value is Record<string, unknown> => value !== null && typeof value === "object")
    .filter((value) => typeof value.question === "string")
    .map((value, index) => ({
      id: String(index),
      question: value.question as string,
    }));
  const answers = block.questionAnswers?.answers;
  const running = block.status === "preparing" || block.status === "running";
  const autoContinued = !running && block.status !== "error" && answers && Object.keys(answers).length === 0;
  const noAnswer = autoContinued ? "未回答，已自动继续" : "未提供回答";
  return {
    running,
    summary: autoContinued ? noAnswer : `${questions.length} 个问题`,
    noAnswer,
    questions: questions.map((question) => {
      const answer = answers && Object.hasOwn(answers, question.question) ? answers[question.question] : "";
      return { ...question, answer: answer.trim() ? answer : noAnswer };
    }),
  };
}
