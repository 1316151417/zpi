import type { AssistantMessage, ToolCall } from "ZPI-ai";
import { emptyAssistant } from "ZPI-ai";
import { projectStreamedToolJournal, SessionManager } from "ZPI-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fakeModel } from "../../../tests/fake-server.ts";
import { restoreView } from "../../desktop/src/main/projection.ts";
import { StreamingToolJournal } from "../src/core/streaming-tool-journal.ts";
import { directory } from "./helpers/session-fixture.ts";

async function fixture() {
  const cwd = await directory();
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendCustomEntry("ZPI.run", { phase: "start", runId: "r", text: "read", startedAt: 1 });
  manager.appendMessage({ role: "user", content: "read", timestamp: 1 });
  const call: ToolCall = { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } };
  const second: ToolCall = { ...call, id: "second" };
  const message: AssistantMessage = {
    ...emptyAssistant(fakeModel("")),
    content: [
      { type: "text", text: "discarded text" },
      { type: "thinking", thinking: "discarded reasoning" },
      call,
      second,
    ],
  };
  const journal = new StreamingToolJournal(manager, () => {});
  journal.observe({ type: "message_start", message });
  const start = (id = call.id) =>
    journal.observe({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "read",
      args: call.arguments,
      executionTiming: "during_stream",
    });
  const end = (id = call.id) =>
    journal.observe({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: `result:${id}` }], details: undefined },
    });
  return { manager, journal, message, call, start, end, file: manager.getSessionFile() as string };
}

for (const completed of [false, true]) {
  it(`restores ${completed ? "a completed" : "an unresolved"} streamed call after a crash without rerunning it`, async () => {
    const f = await fixture();
    f.start();
    if (completed) f.end();
    const before = await readFile(f.file, "utf8");
    expect(before).toContain("ZPI.streaming_tools");
    expect(before).not.toContain("discarded");
    const entries = f.manager.getEntries();
    const snapshot = structuredClone(entries);
    const view = restoreView("s", "read", entries);
    expect(view.runs[0]).toMatchObject({
      status: "interrupted",
      orderedBlocks: [
        { type: "tool", toolCallId: "read", status: completed ? "completed" : "error", isError: !completed },
      ],
    });
    expect(entries).toEqual(snapshot);
    const reopened = SessionManager.open(f.file);
    const messages = reopened.buildSessionContext().messages;
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject(
      completed
        ? { isError: false, content: [{ text: "result:read" }] }
        : { isError: true, details: { reason: "unknown_execution_state" } },
    );
    const recovered = await readFile(f.file, "utf8");
    SessionManager.open(f.file);
    expect(await readFile(f.file, "utf8")).toBe(recovered);
    expect(restoreView("s", "read", reopened.getEntries()).runs[0].orderedBlocks).toEqual(
      view.runs[0].orderedBlocks,
    );
  });
}

it("merges independent call records in declaration order and recovers the gap after assistant commit", async () => {
  const f = await fixture();
  f.start();
  f.start("second");
  f.end("second");
  f.end();
  const final = {
    ...f.message,
    content: f.message.content.filter((c) => c.type === "toolCall"),
    stopReason: "toolUse" as const,
  };
  f.manager.appendMessage(final);
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "read",
    toolName: "read",
    content: [{ type: "text", text: "result:read" }],
    isError: false,
    timestamp: 1,
  });
  const projected = projectStreamedToolJournal(f.manager.getEntries());
  expect(projected.filter((e) => e.type === "message" && e.message.role === "assistant")).toHaveLength(1);
  const reopened = SessionManager.open(f.file);
  expect(
    reopened
      .buildSessionContext()
      .messages.filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId),
  ).toEqual(["read", "second"]);
  expect(reopened.buildSessionContext().messages.filter((m) => m.role === "assistant")).toHaveLength(1);
});

it("a committed journal does not resurrect calls or add model messages", async () => {
  const f = await fixture();
  f.start();
  f.end();
  f.journal.observe({ type: "turn_end", message: f.message, toolResults: [] });
  const before = await readFile(f.file, "utf8");
  expect(projectStreamedToolJournal(f.manager.getEntries())).toEqual(f.manager.getEntries());
  SessionManager.open(f.file);
  expect(await readFile(f.file, "utf8")).toBe(before);
});
