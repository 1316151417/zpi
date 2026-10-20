import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { RunGroup } from "../src/components/Conversation.tsx";
import type { RunView } from "../src/types.ts";

test.each(["running", "completed", "error"] as const)("labels background supplements while %s", (status) => {
  const run: RunView = {
    runId: "supplement",
    userMessage: "<task-notification>PRIVATE NOTIFICATION</task-notification>",
    subagentNotification: { agentId: "agent", agentType: "Explore", description: "核查查询 SQL" },
    status,
    startedAt: 0,
    orderedBlocks: [{ id: "answer", messageId: "message", type: "text", text: "补充结果" }],
    finalAnswerBlockIds: ["answer"],
  };
  const render = (value: RunView) =>
    renderToStaticMarkup(
      createElement(RunGroup, {
        run: value,
        onLink: () => {},
        expanded: false,
        onToggle: () => {},
        blocks: {},
        onBlockToggle: () => {},
      }),
    );
  const markup = render(run);
  expect(markup).toContain("后台补充");
  expect(markup).toContain("核查查询 SQL");
  expect(markup).toContain("补充结果");
  expect(markup).not.toContain("PRIVATE NOTIFICATION");
  expect(render({ ...run, subagentNotification: undefined, userMessage: "用户问题" })).not.toContain(
    "后台补充",
  );
});
