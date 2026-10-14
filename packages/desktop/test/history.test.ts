import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import type { SessionEntry } from "zpi-coding-agent";
import { mergeHistory } from "zpi-ui";
import { fakeModel } from "../../../tests/fake-server.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { restoreView } from "../src/main/projection.ts";

const disposals: (() => void)[] = [];
afterEach(() => {
  for (const dispose of disposals.splice(0)) dispose();
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "zpi-index-"));
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  disposals.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "test.jsonl");
  const index = HistoryIndex.create(path, db, {
    type: "session",
    format: "zpi",
    version: 2,
    id: "test",
    cwd: dir,
    timestamp: new Date().toISOString(),
  });
  let n = 0;
  const append = (fields: object) => {
    const entry = {
      ...fields,
      id: `e${++n}`,
      parentId: index.data.parentId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    index.append(entry);
    return entry;
  };
  return { dir, db, path, index, append };
}
it("persists semantic v2 facts and normalized SQL offsets, rejecting product metadata", async () => {
  const { db, path, index, append } = fixture();
  append({
    type: "custom",
    customType: "zpi.run",
    data: {
      phase: "start",
      runId: "r",
      text: "hello",
      modelConfig: { provider: "openai", modelId: "test" },
      thinkingLevel: "high",
    },
  });
  append({ type: "custom", customType: "zpi.agent_call", data: { phase: "start", ordinal: 0 } });
  append({ type: "message", message: { role: "user", content: "你好", timestamp: 1 } });
  append({ type: "custom", customType: "zpi.agent_call", data: { phase: "end" } });
  append({ type: "custom", customType: "zpi.run", data: { phase: "end", runId: "r", status: "completed" } });
  expect(readFileSync(path, "utf8")).not.toContain('"customType"');
  expect(db.prepare("SELECT count(*) AS n FROM transcript_entries").get()?.n).toBe(5);
  expect(index.findRun("r")?.end).toBeDefined();
  expect(index.getStateAt(index.snapshot())).toMatchObject({
    model: { provider: "openai", modelId: "test" },
    thinkingLevel: "high",
  });
  expect(() => append({ type: "custom", customType: "zpi.title", data: { title: "no" } })).toThrow(
    /metadata/,
  );
  const reopened = new HistoryIndex(path, db);
  await reopened.load();
  expect(reopened.readBytes).toBeLessThan(256);
  expect(reopened.page().entries).toEqual(index.page().entries);
});
it("rebuilds only derived tables and catches up an unindexed durable tail", async () => {
  const { db, path, index, append } = fixture();
  append({ type: "message", message: { role: "user", content: "first", timestamp: 1 } });
  const before = index.snapshot();
  const end = index.data.size;
  append({ type: "message", message: { role: "user", content: "second", timestamp: 2 } });
  db.prepare("DELETE FROM transcript_entries WHERE seq=2").run();
  db.prepare("UPDATE transcript_state SET seq=1,parent_id='e1',size=?").run(end);
  const reopened = new HistoryIndex(path, db);
  await reopened.load();
  expect(reopened.snapshot().endSeq).toBe(2);
  expect([...reopened.readRange(1, 2, before)]).toHaveLength(1);
  db.prepare("DELETE FROM transcript_state").run();
  const rebuilt = new HistoryIndex(path, db);
  await rebuilt.load();
  expect(rebuilt.snapshot().endSeq).toBe(2);
  expect(rebuilt.readBytes).toBeGreaterThan(0);
});
it("never truncates or silently skips malformed complete records or partial tails", async () => {
  const { db, path, append } = fixture();
  append({ type: "message", message: { role: "user", content: "keep me", timestamp: 1 } });
  appendFileSync(path, '{"broken"');
  const original = readFileSync(path);
  await expect(new HistoryIndex(path, db).load()).rejects.toThrow(/Unterminated/);
  expect(readFileSync(path)).toEqual(original);
  appendFileSync(path, "\n");
  await expect(new HistoryIndex(path, db).load()).rejects.toThrow(/Invalid JSONL/);
  expect(readFileSync(path)).toEqual(Buffer.concat([original, Buffer.from("\n")]));
});
it("uses byte-bounded pages and materializes only retained compaction message ranges", () => {
  const { index, append } = fixture();
  for (let i = 0; i < 12; i++)
    append({ type: "message", message: { role: "user", content: "x".repeat(300000), timestamp: i } });
  const retained = append({ type: "message", message: { role: "user", content: "保留", timestamp: 20 } });
  append({
    type: "compaction",
    summary: "summary",
    firstKeptEntryId: retained.id,
    systemMessage: { role: "system", content: "system", timestamp: 21 },
  });
  append({ type: "message", message: { role: "user", content: "tail", timestamp: 22 } });
  index.readBytes = 0;
  const plan = index.getContextPlan(index.snapshot());
  const range = [...index.readRange(plan.firstKeptSeq, plan.snapshot.endSeq, plan.snapshot, ["message"])];
  expect(range.map((e) => e.entry.type)).toEqual(["message", "message"]);
  expect(index.readBytes).toBeLessThan(2000);
  index.readBytes = 0;
  const page = index.page();
  expect(index.readBytes).toBeLessThan(2 * 1024 * 1024);
  expect(page.cursor).not.toBeNull();
});
it("keeps cache usage as a bounded projection without loading assistant body on warm open", async () => {
  const { append, db, path } = fixture();
  const message = emptyAssistant(fakeModel(""));
  message.content = [{ type: "text", text: "x".repeat(1000000) }];
  message.usageAvailable = message.cacheUsageAvailable = true;
  message.usage = { ...message.usage, input: 10, cacheRead: 100, cacheWrite: 890, totalTokens: 1000 };
  append({ type: "message", message });
  const reopened = new HistoryIndex(path, db);
  await reopened.load();
  expect(reopened.data.cacheInput).toBe(1000);
  expect(reopened.getState().usage).toMatchObject({ message: { content: [] } });
  expect(reopened.readBytes).toBeLessThan(256);
});
it("rejects legacy headers instead of reading product metadata as authority", async () => {
  const { path, db } = fixture();
  writeFileSync(
    path,
    `${JSON.stringify({
      type: "session",
      version: 1,
      format: "zpi",
      id: "legacy",
      cwd: "/",
      timestamp: new Date().toISOString(),
    })}\n`,
  );
  await expect(new HistoryIndex(path, db).load()).rejects.toThrow(/migrate legacy/);
});

it("rebuilds corrupt derived metadata without changing authoritative bytes or business tables", async () => {
  const { db, path, index, append } = fixture();
  append({ type: "message", message: { role: "user", content: "authority", timestamp: 1 } });
  const bytes = readFileSync(path);
  db.exec("CREATE TABLE business_state(value TEXT); INSERT INTO business_state VALUES('keep')");
  for (const corruption of [
    "UPDATE transcript_state SET header='broken'",
    "UPDATE transcript_entries SET length=1",
    "INSERT OR REPLACE INTO transcript_checkpoints VALUES('test.jsonl',1,'null')",
  ]) {
    db.exec(corruption);
    const reopened = new HistoryIndex(path, db);
    await reopened.load();
    expect(reopened.getTail(reopened.snapshot())?.entry.id).toBe(index.data.parentId);
    expect(readFileSync(path)).toEqual(bytes);
    expect(db.prepare("SELECT value FROM business_state").get()?.value).toBe("keep");
  }
});

it("repairs only a fully validated missing final newline, idempotently", async () => {
  const { db, path, append } = fixture();
  append({ type: "message", message: { role: "user", content: "valid tail", timestamp: 1 } });
  const original = readFileSync(path);
  writeFileSync(path, original.subarray(0, -1));
  const reopened = new HistoryIndex(path, db);
  await reopened.load();
  expect(readFileSync(path)).toEqual(original);
  expect(reopened.snapshot().endSeq).toBe(1);
  await new HistoryIndex(path, db).load();
  expect(readFileSync(path)).toEqual(original);
});

it("keeps generation files immutable on replacement failure and rejects stale snapshots after publication", () => {
  const { path, index, append, db } = fixture();
  append({ type: "message", message: { role: "user", content: "old", timestamp: 1 } });
  const original = readFileSync(path);
  const oldSnapshot = index.snapshot();
  const next: SessionEntry = {
    type: "message",
    id: "new",
    parentId: null,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "new", timestamp: 2 },
  };
  expect(() => index.replace(index.getHeader(), [next, next])).toThrow();
  expect(index.getFile()).toBe(path);
  expect(readFileSync(path)).toEqual(original);
  index.replace(index.getHeader(), [next]);
  expect(index.getFile()).not.toBe(path);
  expect(index.key).not.toContain(index.getHeader().cwd);
  expect(readFileSync(path)).toEqual(original);
  expect(() => index.getTail(oldSnapshot)).toThrow(/Stale/);
  expect(db.prepare("SELECT path FROM transcript_state WHERE path=?").get(index.key)).toBeDefined();
});

it("subpages giant runs without rereading input, losing messages, or overwriting the complete input", () => {
  const { index, append } = fixture();
  const text = "original input".repeat(180000);
  append({
    type: "custom",
    customType: "zpi.run",
    data: {
      phase: "start",
      runId: "large",
      text,
      startedAt: 1,
      ordinalStart: 7,
      attachments: [],
      fileReferences: ["original.ts"],
    },
  });
  for (let i = 0; i < 12; i++) {
    const message = emptyAssistant(fakeModel(""));
    message.content = [{ type: "text", text: `${i}:${"x".repeat(350000)}` }];
    append({ type: "message", message });
  }
  const full = restoreView(
    "test",
    "",
    [...index.readRange(1, index.snapshot().endSeq, index.snapshot())].map((e) => e.entry),
  );
  index.readBytes = 0;
  let page = index.page();
  expect(index.readBytes).toBeLessThanOrEqual(2 * 1024 * 1024);
  let view = restoreView("test", "", page.entries);
  expect(view.runs[0].historyContinuation).toBe(true);
  const continuation = view;
  while (page.cursor !== null) {
    index.readBytes = 0;
    page = index.page(page.cursor);
    expect(index.readBytes).toBeLessThanOrEqual(8 * 1024 * 1024 + 1);
    view = mergeHistory(restoreView("test", "", page.entries), view);
  }
  expect(view.runs[0].userMessage).toBe(text);
  expect(view.runs[0].fileReferences).toEqual(["original.ts"]);
  expect(view.runs[0].orderedBlocks).toEqual(full.runs[0].orderedBlocks);
  expect(mergeHistory(view, continuation).runs[0].userMessage).toBe(text);
  expect(index.page(0)).toEqual({ entries: [], cursor: null, calls: 0 });
});

it("rejects prototype names and invalid semantic fact payloads before writing", () => {
  const { path, append } = fixture();
  const original = readFileSync(path);
  for (const customType of ["constructor", "toString", "__proto__"])
    expect(() => append({ type: "custom", customType, data: {} })).toThrow(/metadata/);
  expect(() => append({ type: "custom", customType: "zpi.run", data: null })).toThrow(/payload/);
  expect(readFileSync(path)).toEqual(original);
  append({ type: "custom", customType: "zpi.notice", data: { runId: "r", text: "diagnostic" } });
  expect(readFileSync(path, "utf8")).toContain('"type":"diagnostic"');
});

it("rebuilds missing derived tables instead of trusting a stale state watermark", async () => {
  const { db, path, append } = fixture();
  append({ type: "custom", customType: "zpi.run", data: { phase: "start", runId: "r", text: "hello" } });
  append({ type: "message", message: { role: "user", content: "hello", timestamp: 1 } });
  const original = readFileSync(path);
  db.exec("DROP TABLE transcript_anchors");
  const reopened = new HistoryIndex(path, db);
  await reopened.load();
  expect(reopened.page(3).entries).toHaveLength(2);
  expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_anchors").get()?.n).toBe(1);
  expect(readFileSync(path)).toEqual(original);
});

it("does not prefix a previous run when a page already starts at the next run boundary", () => {
  const { index, append } = fixture();
  append({ type: "custom", customType: "zpi.run", data: { phase: "start", runId: "first", text: "first" } });
  append({
    type: "custom",
    customType: "zpi.run",
    data: { phase: "end", runId: "first", status: "completed" },
  });
  append({
    type: "custom",
    customType: "zpi.run",
    data: { phase: "start", runId: "second", text: "x".repeat(2100000) },
  });
  expect(restoreView("test", "", index.page().entries).runs.map((run) => run.runId)).toEqual(["second"]);
});

it("repeated rewrites keep a bounded generation filename and preserve the prior files", () => {
  const { index, path, append } = fixture();
  append({ type: "message", message: { role: "user", content: "retained", timestamp: 1 } });
  const original = readFileSync(path, "utf8");
  for (let i = 0; i < 12; i++) {
    const snapshot = index.snapshot();
    const entries = function* () {
      for (const { entry } of index.readRange(1, snapshot.endSeq, snapshot)) yield entry;
    };
    index.replace(index.getHeader(), entries());
    expect(index.path.split("generation-")).toHaveLength(2);
  }
  expect(readFileSync(path, "utf8")).toBe(original);
});
