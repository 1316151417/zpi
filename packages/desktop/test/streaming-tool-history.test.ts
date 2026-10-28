import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { StreamingToolJournal } from "../../coding-agent/src/core/streaming-tool-journal.ts";
import { HistoryIndex } from "../src/main/history-index.ts";

it("recovers only unresolved journal facts, preserves known results, and never duplicates recovery", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zpi-journal-"));
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  try {
    const path = join(dir, "session.jsonl");
    const index = HistoryIndex.create(path, db, {
      type: "session",
      version: 2,
      format: "zpi",
      id: "journal",
      cwd: dir,
      timestamp: new Date().toISOString(),
    });
    const manager = SessionManager.fromStore(index);
    manager.appendMessage({ role: "user", content: "read", timestamp: 1 });
    const call = { type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } };
    const message = { ...emptyAssistant(fakeModel("")), content: [call] };
    const journal = new StreamingToolJournal(manager, () => {});
    await journal.observe({ type: "message_start", message });
    await journal.observe({
      type: "tool_execution_start",
      toolCallId: "read",
      toolName: "read",
      args: call.arguments,
      executionTiming: "during_stream",
    });
    await journal.observe({
      type: "tool_execution_end",
      toolCallId: "read",
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: "read before crash" }], details: undefined },
    });
    const reopened = new HistoryIndex(path, db);
    await reopened.load();
    expect([...reopened.readUnresolvedToolJournals(reopened.snapshot())]).toHaveLength(1);
    const interruptedSnapshot = reopened.snapshot();
    SessionManager.fromStore(reopened);
    expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_pending_journals").get()?.n).toBe(0);
    expect([...reopened.readUnresolvedToolJournals(interruptedSnapshot)]).toHaveLength(1);
    const results = [
      ...reopened.readRange(1, reopened.snapshot().endSeq, reopened.snapshot(), ["message"]),
    ].filter((e) => e.entry.type === "message" && e.entry.message.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0].entry).toMatchObject({
      message: { content: [{ type: "text", text: "read before crash" }] },
    });
    const end = reopened.snapshot().endSeq;
    SessionManager.fromStore(reopened);
    expect(reopened.snapshot().endSeq).toBe(end);
    expect([...reopened.readUnresolvedToolJournals(reopened.snapshot())]).toHaveLength(0);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
