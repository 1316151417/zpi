import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { type AssistantMessage, emptyAssistant, type Message } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { RunGroup } from "../../ui/src/components/Conversation.tsx";
import { runPresentation } from "../../ui/src/components/process-presentation.ts";
import { emptySession, reduceSession } from "../../ui/src/reducer.ts";
import type { DesktopEvent } from "../../ui/src/types.ts";
import { projectEvent, restoreView } from "../src/main/projection.ts";

const answer = "查询 SQL：SELECT 231 AS metric;";
const assistant = (content: AssistantMessage["content"], fields: Partial<AssistantMessage> = {}) => ({
  ...emptyAssistant(fakeModel("")),
  content,
  ...fields,
});

function fixture(mode: "live" | "restored") {
  const manager = SessionManager.inMemory();
  let view = emptySession("s");
  let seq = 0;
  let ordinal = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
    return view.runs[0];
  };
  manager.appendCustomEntry("zpi.run", { phase: "start", runId: "r", text: "查询业绩", startedAt: 1 });
  apply({ type: "started", text: "查询业绩", startedAt: 1, modelLabel: "fake" });
  const append = (message: Message) => {
    const messageId = `r:${++ordinal}`;
    manager.appendMessage(message);
    apply({ type: "message_start", messageId, role: message.role });
    if (message.role === "assistant") {
      for (const [contentIndex, block] of message.content.entries()) {
        apply({
          type: "block_start",
          messageId,
          contentIndex,
          kind: block.type === "toolCall" ? "tool" : block.type,
          ...(block.type === "toolCall" ? { toolCall: block } : {}),
        });
        if (block.type !== "toolCall")
          apply({
            type: "block_delta",
            messageId,
            contentIndex,
            delta: block.type === "text" ? block.text : block.thinking,
          });
      }
    }
    const event = projectEvent({ type: "message_end", message }, messageId);
    if (event) apply(event);
    return view.runs[0];
  };
  const finish = () => {
    manager.appendCustomEntry("zpi.run", { phase: "end", runId: "r", status: "completed", endedAt: 10 });
    apply({ type: "settled", status: "completed", endedAt: 10 });
    return mode === "live" ? view.runs[0] : restoreView("s", "task", manager.getEntries()).runs[0];
  };
  return { apply, append, finish };
}

describe.each(["live", "restored"] as const)("%s replies", (mode) => {
  it.each([
    { text: "", thinking: "" },
    { text: " \n\t", thinking: "" },
    { text: null, thinking: "" },
    { text: "", thinking: "Awaiting user input" },
    { text: " \n\t", thinking: "Awaiting user input" },
    { text: null, thinking: "Awaiting user input" },
  ])("keeps the answer visible after a follow-up with no prose (%j)", ({ text, thinking }) => {
    const { append, finish } = fixture(mode);
    append(assistant([{ type: "thinking", thinking: "核对表名" }]));
    append(assistant([{ type: "text", text: answer, phase: "final_answer" }]));
    append({
      role: "user",
      content: "<subagent-message>已收尾，无需补充。</subagent-message>",
      timestamp: 5,
    });
    const empty: AssistantMessage["content"] = [{ type: "thinking", thinking }];
    if (text !== null) empty.push({ type: "text", text, phase: "final_answer" });
    const running = append(assistant(empty));
    expect(runPresentation(running).answer).toBeUndefined();
    const run = finish();
    expect(run.finalAnswerBlockIds).toEqual(["r:2:0"]);
    expect(runPresentation(run)).toMatchObject({ answer: { text: answer }, defaultOpen: false });
    const markup = renderToStaticMarkup(
      createElement(RunGroup, {
        run,
        onLink: () => {},
        expanded: false,
        onToggle: () => {},
        blocks: {},
        onBlockToggle: () => {},
      }),
    );
    expect(markup).toContain(answer);
    expect(markup).not.toContain("核对表名");
    expect(markup).not.toContain("Awaiting user input");
    expect(markup).not.toContain('data-testid="process"');
    if (thinking)
      expect(runPresentation(run).process).toContainEqual(expect.objectContaining({ text: thinking }));
  });

  it("keeps the newest real answer through repeated empty replies", () => {
    const { append, finish } = fixture(mode);
    append(assistant([{ type: "text", text: answer }]));
    append(assistant([]));
    append(
      assistant([
        { type: "text", text: "补充后的答案" },
        { type: "text", text: " " },
      ]),
    );
    append(assistant([{ type: "text", text: "" }]));
    append(assistant([{ type: "thinking", thinking: "" }]));
    const run = finish();
    expect(run.finalAnswerBlockIds).toEqual(["r:3:0"]);
    expect(runPresentation(run).answer?.text).toBe("补充后的答案");
  });

  it("keeps tool work open when an empty reply follows a new tool call", () => {
    const { append, finish } = fixture(mode);
    append(assistant([{ type: "text", text: answer }]));
    append(
      assistant([{ type: "toolCall", id: "read", name: "read", arguments: { path: "notes.md" } }], {
        stopReason: "toolUse",
      }),
    );
    append({
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "text", text: "notes" }],
      isError: false,
      timestamp: 5,
    });
    append(assistant([{ type: "text", text: "" }]));
    const run = finish();
    expect(run.finalAnswerBlockIds).toEqual([]);
    expect(runPresentation(run)).toMatchObject({ answer: undefined, defaultOpen: true });
  });

  it("does not revive a failed reply when its replacement is empty", () => {
    const { append, finish } = fixture(mode);
    append(assistant([{ type: "text", text: "未完成的回复" }], { stopReason: "error", errorMessage: "503" }));
    append(assistant([{ type: "text", text: "" }]));
    const run = finish();
    expect(run.finalAnswerBlockIds).toEqual([]);
    expect(run.orderedBlocks[0]).toMatchObject({ interrupted: true });
    expect(runPresentation(run)).toMatchObject({ answer: undefined, defaultOpen: true });
  });
});

it("does not retain streamed text discarded by the completed message", () => {
  const { apply, append, finish } = fixture("live");
  apply({ type: "block_start", messageId: "r:1", contentIndex: 0, kind: "text" });
  apply({ type: "block_delta", messageId: "r:1", contentIndex: 0, delta: "discarded" });
  append(assistant([{ type: "text", text: "" }]));
  const run = finish();
  expect(run.finalAnswerBlockIds).toEqual([]);
  expect(runPresentation(run)).toEqual({ process: [], answer: undefined, defaultOpen: false });
});
