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

test.each([
  "413 Failed to buffer the request body: length limit exceeded",
  "HTTP 413 Payload Too Large",
  "Request failed with status code 413: request body exceeds limit",
  { status: 413, message: "Failed to buffer the request body: length limit exceeded" },
  { statusCode: 413, message: "Request body too large" },
])("explains oversized requests with concrete recovery steps", (error) => {
  expect(userErrorMessage(error)).toBe("本次请求内容过大，请压缩对话或开启新会话后重试。");
});
test("explains current attachment rejection without suggesting automatic recovery", () => {
  expect(
    userErrorMessage("MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE: Current attachments are too large to send."),
  ).toBe("本次附件过大，请移除或压缩附件后重试。");
});

test.each([
  "failed at line 413",
  "port 413 refused",
  "received 413 bytes",
  "model-413 failed",
  "large payload failed at line 413",
])("does not misclassify an incidental 413 as a request limit: %s", (error) => {
  expect(userErrorMessage(error)).not.toContain("本次请求内容过大");
});
test.each([
  "ENOENT: no such file or directory, open '/tmp/413/large.png'",
  {
    code: "ENOENT",
    path: "/tmp/413/payload.png",
    message: "ENOENT: open failed for large file 413",
  },
])("keeps file errors recognizable when their paths contain 413 and request-limit words", (error) => {
  expect(userErrorMessage(error)).toContain("找不到文件");
});
