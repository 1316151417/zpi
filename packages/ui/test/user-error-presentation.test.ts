import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";
import { CompactionDivider } from "../src/components/CompactionDivider.tsx";
import { RunGroup } from "../src/components/Conversation.tsx";
import { ConversationQueuePanel } from "../src/components/ConversationQueuePanel.tsx";
import { ToolFilePreview } from "../src/components/ToolBlock.tsx";
import type { RunView } from "../src/types.ts";
import { userErrorMessage } from "../src/user-error.ts";

const technical = "storage: TypeError: private-internal-marker";
const run = (error: string): RunView => ({
  runId: "run",
  userMessage: "你好",
  status: "error",
  startedAt: 0,
  finalAnswerBlockIds: [],
  orderedBlocks: [],
  error,
});
const renderRun = (error: string) =>
  renderToStaticMarkup(
    createElement(RunGroup, {
      run: run(error),
      onLink: () => {},
      expanded: false,
      onToggle: () => {},
      blocks: {},
      onBlockToggle: () => {},
    }),
  );

test.each([
  technical,
  "provider: 401 unauthorized private-internal-marker",
  "configuration: 请先选择有效模型",
])("renders friendly conversation errors without changing the stored error: %s", (error) => {
  const markup = renderRun(error);
  expect(markup).toContain(userErrorMessage(error));
  expect(markup).not.toContain("private-internal-marker");
  expect(run(error).error).toBe(error);
});

test("sanitizes compaction error tooltips", () => {
  const markup = renderToStaticMarkup(
    createElement(CompactionDivider, {
      marker: { id: "compact", status: "error", origin: "auto", error: technical },
    }),
  );
  expect(markup).toContain(`title="${userErrorMessage(technical)}"`);
  expect(markup).not.toContain("private-internal-marker");
});

test("sanitizes persisted queue errors", () => {
  const action = async () => {};
  const markup = renderToStaticMarkup(
    createElement(ConversationQueuePanel, {
      queue: {
        autoDrain: false,
        error: technical,
        items: [
          {
            id: "queued",
            text: "下一条",
            fileReferences: [],
            attachments: [],
            state: "queued",
            selection: { provider: "provider", modelId: "model", reasoning: "off" },
          },
        ],
      },
      actions: { remove: action, edit: action, sendNow: action, move: action, resume: action },
      onError: () => {},
    }),
  );
  expect(markup).toContain(userErrorMessage(technical));
  expect(markup).not.toContain("private-internal-marker");
});

test("retains technical tool failure output unchanged", () => {
  const markup = renderToStaticMarkup(
    createElement(ToolFilePreview, {
      block: {
        id: "block",
        messageId: "message",
        type: "tool",
        toolCallId: "call",
        name: "edit",
        argsText: "{}",
        status: "error",
        output: technical,
      },
    }),
  );
  expect(markup).toContain(technical);
  expect(markup).not.toContain(userErrorMessage(technical));
});
