import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RunGroup } from "../src/components/Conversation.tsx";
import type { RunView } from "../src/types.ts";
import { userErrorMessage } from "../src/user-error.ts";

const render = (run: RunView) =>
  renderToStaticMarkup(
    createElement(RunGroup, {
      run,
      onLink: () => {},
      expanded: false,
      onToggle: () => {},
      blocks: {},
      onBlockToggle: () => {},
    }),
  );

const backgroundRun = (status: RunView["status"]): RunView => ({
  runId: "supplement",
  userMessage: "<task-notification>PRIVATE NOTIFICATION</task-notification>",
  subagentNotification: { agentId: "agent", agentType: "Explore", description: "核查查询 SQL" },
  status,
  startedAt: 0,
  orderedBlocks: [
    { id: "intro", messageId: "first", type: "text", text: "核查过程说明" },
    {
      id: "tool",
      messageId: "first",
      type: "tool",
      toolCallId: "bash",
      name: "bash",
      argsText: '{"command":"rg SELECT query.sql"}',
      status: "completed",
      output: "SELECT 1",
    },
    { id: "answer", messageId: "last", type: "text", text: "补充结果" },
  ],
  finalAnswerBlockIds: ["answer"],
});

test.each(["running", "completed", "error", "aborted", "interrupted"] as const)(
  "shows background results without a work-duration fold while %s",
  (status) => {
    const markup = render(backgroundRun(status));
    expect(markup).toContain('data-testid="background-result-heading">核查查询 SQL</div>');
    expect(markup).toContain("核查过程说明");
    expect(markup).toContain("query.sql");
    expect(markup).toContain("补充结果");
    expect(markup).not.toContain('data-testid="progress"');
    expect(markup).not.toContain("后台补充");
    expect(markup).not.toContain("PRIVATE NOTIFICATION");
  },
);

test("preserves errors and process when a background result has no final answer", () => {
  const run = backgroundRun("error");
  run.orderedBlocks.pop();
  run.finalAnswerBlockIds = [];
  run.error = "Background lookup failed";
  const markup = render(run);
  expect(markup).toContain("核查过程说明");
  expect(markup).toContain("query.sql");
  expect(markup).toContain(userErrorMessage(run.error));
  expect(markup).toContain('role="alert"');
  expect(markup).not.toContain('data-testid="progress"');
});

test("keeps normal completed replies behind their work-duration fold", () => {
  const markup = render({
    ...backgroundRun("completed"),
    subagentNotification: undefined,
    userMessage: "用户问题",
  });
  expect(markup).toContain('data-testid="progress"');
  expect(markup).toContain("补充结果");
  expect(markup).not.toContain("核查过程说明");
  expect(markup).not.toContain('data-testid="background-result-heading"');
});
