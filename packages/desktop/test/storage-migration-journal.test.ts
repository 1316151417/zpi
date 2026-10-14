import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type AssistantMessage, emptyAssistant, type ToolCall, type ToolResultMessage } from "zpi-ai";
import {
  type LegacySession,
  type Row,
  readLegacySession,
} from "../../../scripts/storage-migration/legacy.ts";
import { recoverLegacyJournals } from "../../../scripts/storage-migration/legacy-journal.ts";
import { fakeModel } from "../../../tests/fake-server.ts";

const timestamp = "2026-01-01T00:00:00.000Z";
const recoveryAt = "2026-10-01T00:00:00.000Z";
const sessions: LegacySession[] = [];
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const session of sessions.splice(0)) session.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const call = (id: string): ToolCall => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
const assistant = (...ids: string[]): AssistantMessage => ({
  ...emptyAssistant(fakeModel("")),
  content: ids.map(call),
});
const result = (id: string, text: string): ToolResultMessage => ({
  role: "toolResult",
  toolCallId: id,
  toolName: "bash",
  content: [{ type: "text", text }],
  isError: false,
  timestamp: 1,
});
const message = (value: AssistantMessage | ToolResultMessage): Row => ({ type: "message", message: value });
const user: Row = { type: "message", message: { role: "user", content: "anchor", timestamp: 1 } };
const journal = (id: string, ids: string[], fields: Row = {}): Row => ({
  type: "custom",
  customType: "zpi.streaming_tools",
  data: { id, anchorId: "e0", assistant: assistant(...ids), results: [], ...fields },
});
async function fixture(rows: Row[]) {
  const root = await mkdtemp(join(tmpdir(), "zpi-migration-journals-"));
  roots.push(root);
  const entries = rows.map((row, index) => ({
    ...row,
    id: `e${index}`,
    parentId: index ? `e${index - 1}` : null,
    timestamp,
  }));
  const path = join(root, "session.jsonl");
  await writeFile(
    path,
    `${[{ type: "session", version: 1, format: "zpi", id: "test", cwd: "/fixture", timestamp }, ...entries]
      .map((entry) => JSON.stringify(entry))
      .join("\n")}\n`,
  );
  const session = await readLegacySession(path);
  sessions.push(session);
  return { session, entries };
}
const recover = (session: LegacySession) =>
  recoverLegacyJournals(session.entries, "migration-id", recoveryAt);
const additions = (entries: Iterable<Row>) =>
  [...entries].filter((entry) => String(entry.id).startsWith("migration-"));

describe("disk-backed offline journal recovery", () => {
  it("merges checkpoints in response order, keeps latest results, and uses stable interrupted IDs", async () => {
    const { session, entries } = await fixture([
      user,
      journal("j", ["a"], { results: [result("a", "old")] }),
      journal("j", ["b"], { results: [result("a", "latest")] }),
      journal("j", ["b", "a", "c"], { responseComplete: true }),
      journal("j", ["b"], { results: [result("b", "done")] }),
    ]);
    const output = [...recover(session)];
    expect(output.slice(0, entries.length)).toEqual(entries);
    const added = additions(output);
    expect((added[0].message as AssistantMessage).content).toEqual([call("b"), call("a"), call("c")]);
    expect(added[1].message).toEqual(result("b", "done"));
    expect(added[2].message).toEqual(result("a", "latest"));
    expect(added[3].message).toMatchObject({
      role: "toolResult",
      toolCallId: "c",
      isError: true,
      timestamp: Date.parse(recoveryAt),
      details: { type: "stream_recovery_interrupted_tool", reason: "unknown_execution_state" },
    });
    expect(added[4]).toMatchObject({
      type: "custom",
      customType: "zpi.streaming_tools",
      data: { id: "j", committed: true },
    });
    for (const [ordinal, row] of added.entries())
      expect(row).toMatchObject({
        id: `migration-${createHash("sha256").update(`migration-id:j:${ordinal}`).digest("hex").slice(0, 32)}`,
        parentId: "e4",
        timestamp: recoveryAt,
      });
    expect([...recover(session)]).toEqual(output);
  });

  it("uses canonical calls and paired results only before the next assistant", async () => {
    const { session } = await fixture([
      user,
      journal("j", ["a", "b"], { results: [result("a", "journal stale")] }),
      message(assistant("b", "a", "c")),
      message(result("b", "canonical b")),
      { type: "custom", customType: "zpi.notice", data: { text: "between results" } },
      message(result("a", "canonical a")),
      message(assistant()),
      message(result("c", "outside response")),
    ]);
    const output = [...recover(session)];
    const added = additions(output);
    expect(added).toHaveLength(2);
    expect(added[0].message).toMatchObject({
      role: "toolResult",
      toolCallId: "c",
      details: { reason: "unknown_execution_state" },
    });
    expect(added[0].parentId).toBe("e5");
    expect(output.findIndex((entry) => entry.id === added[0].id)).toBe(6);
    expect(output.filter((entry) => (entry.message as Row | undefined)?.role === "assistant")).toHaveLength(
      2,
    );
  });

  it("retains first pending journal order when canonical results share an insertion point", async () => {
    const { session } = await fixture([
      user,
      journal("z-first", ["a"]),
      journal("a-second", ["b"]),
      message(assistant("a", "b")),
      message(result("a", "a")),
      message(result("b", "b")),
    ]);
    const added = additions(recover(session));
    expect(added).toHaveLength(2);
    expect(added.map((entry) => entry.data)).toEqual([
      { id: "z-first", committed: true },
      { id: "a-second", committed: true },
    ]);
    expect(added.map((entry) => entry.parentId)).toEqual(["e5", "e5"]);
  });

  it("skips committed malformed snapshots and recovers only updates after the latest commit", async () => {
    const { session, entries } = await fixture([
      user,
      journal("j", [], { assistant: "already committed malformed snapshot" }),
      journal("j", [], { committed: true }),
      journal("j", ["new"]),
      journal("finished", [], { assistant: "also already committed" }),
      journal("finished", [], { committed: true }),
    ]);
    const output = [...recover(session)];
    const added = additions(output);
    expect(added).toHaveLength(3);
    expect((added[0].message as AssistantMessage).content).toEqual([call("new")]);
    expect(output.filter((entry) => String(entry.id).startsWith("e"))).toEqual(entries);
  });

  it("does not parse or materialize unrelated history before yielding its first original record", async () => {
    const { session } = await fixture([...Array.from({ length: 1200 }, () => user), journal("j", ["a"])]);
    const parse = vi.spyOn(JSON, "parse");
    const stream = recover(session);
    expect(Array.isArray(stream)).toBe(false);
    expect(stream.next().value).toMatchObject({ id: "e0" });
    expect(parse.mock.calls.length).toBeLessThanOrEqual(3);
    stream.return?.();
    parse.mockRestore();
    // Returning early releases SQLite cursors; the same disk-backed source is reusable.
    expect(additions(recover(session))).toHaveLength(3);
  });

  it("rejects missing anchors and invalid pending calls before yielding recovered output", async () => {
    const missing = await fixture([user, journal("j", ["a"], { anchorId: "missing" })]);
    expect(() => [...recover(missing.session)]).toThrow("Missing streaming journal anchor");
    const invalid = await fixture([
      user,
      journal("j", [], {
        assistant: { ...assistant(), content: [{ type: "text", text: "invalid journal" }] },
      }),
    ]);
    expect(() => [...recover(invalid.session)]).toThrow("Invalid streaming tool call");
  });

  it("passes committed-only histories through without allocating a recovery table", async () => {
    const { session, entries } = await fixture([
      user,
      journal("j", [], { assistant: "not needed" }),
      journal("j", [], { committed: true }),
    ]);
    expect([...recover(session)]).toEqual(entries);
    expect(
      session.entries.db.prepare("SELECT name FROM sqlite_schema WHERE name='recovery_additions'").get(),
    ).toBeUndefined();
  });
});
