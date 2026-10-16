import { fsyncSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { maxSessionEntryBytes, type SessionEntry, SessionManager } from "zpi-coding-agent";
import { type GenerationHooks, HistoryIndex } from "../src/main/history-index.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    openSync: vi.fn(fs.openSync),
    writeSync: vi.fn(fs.writeSync),
    fsyncSync: vi.fn(fs.fsyncSync),
  };
});
const disposals: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(openSync).mockReset();
  vi.mocked(writeSync).mockReset();
  vi.mocked(fsyncSync).mockReset();
  for (const dispose of disposals.splice(0)) dispose();
});
async function fixture(hooks?: GenerationHooks) {
  const fs = await vi.importActual<typeof import("node:fs")>("node:fs");
  vi.mocked(openSync).mockImplementation(fs.openSync);
  vi.mocked(writeSync).mockImplementation(fs.writeSync);
  vi.mocked(fsyncSync).mockImplementation(fs.fsyncSync);
  const dir = mkdtempSync(join(tmpdir(), "zpi-bulk-"));
  const db = new DatabaseSync(join(dir, "state.sqlite"));
  disposals.push(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const path = join(dir, "test.jsonl");
  const index = HistoryIndex.create(
    path,
    db,
    {
      type: "session",
      format: "zpi",
      version: 2,
      id: "test",
      cwd: dir,
      timestamp: new Date().toISOString(),
    },
    hooks,
  );
  index.append(entry(0));
  vi.mocked(openSync).mockClear();
  vi.mocked(writeSync).mockClear();
  vi.mocked(fsyncSync).mockClear();
  return { fs, dir, db, path, index };
}
function entry(n: number): SessionEntry {
  return {
    type: "message",
    id: `new-${n}`,
    parentId: n > 1 ? `new-${n - 1}` : null,
    timestamp: new Date(1).toISOString(),
    message: { role: "user", content: `message ${n} 中文`, timestamp: n },
  };
}

it("streams each entry through one file handle and one index commit before publishing", async () => {
  const commit = vi.fn();
  const { index, db, path } = await fixture({ prepare: vi.fn(), commit });
  const original = readFileSync(path);
  const flush = vi.spyOn(HistoryIndex.prototype, "flush");
  const exec = vi.spyOn(db, "exec");

  function* source() {
    for (let n = 1; n <= 250; n++) {
      // Consumption must interleave with indexing/writing; never collect the iterable first.
      expect(db.prepare("SELECT count(*) AS n FROM transcript_entries WHERE path<>?").get(index.key)?.n).toBe(
        n - 1,
      );
      expect(vi.mocked(writeSync)).toHaveBeenCalledTimes(n);
      expect(commit).not.toHaveBeenCalled();
      yield entry(n);
    }
  }
  index.replace(index.getHeader(), source());
  expect(openSync).toHaveBeenCalledWith(index.path, "wx", 0o600);
  expect(vi.mocked(openSync).mock.calls.filter((call) => call[1] === "wx")).toHaveLength(1);
  expect(vi.mocked(openSync).mock.calls.filter((call) => call[1] === "a")).toHaveLength(0);
  expect(fsyncSync).toHaveBeenCalledTimes(process.platform === "win32" ? 1 : 2);
  expect(flush).toHaveBeenCalledOnce();
  expect(exec.mock.calls.filter(([sql]) => sql === "SAVEPOINT transcript_write")).toHaveLength(2);
  expect(commit).toHaveBeenCalledExactlyOnceWith(path, index.path, index.getHeader(), index.data.size);
  expect(readFileSync(path)).toEqual(original);
  expect(index.snapshot().endSeq).toBe(250);
  expect(index.getTail(index.snapshot())?.entry).toMatchObject({ id: "new-250" });
  const reopened = new HistoryIndex(index.path, db);
  await reopened.load();
  expect(reopened.snapshot()).toEqual(index.snapshot());
  expect(reopened.getTail(reopened.snapshot())?.entry).toMatchObject({ id: "new-250" });
});

for (const failure of [
  "write",
  "zero-write",
  "index",
  "flush",
  "fsync",
  "directory-sync",
  "iterator",
  "validation",
  "duplicate",
  "compaction",
  "publication",
] as const) {
  it(`keeps the previous generation readable after ${failure} failure`, async () => {
    let target = "";
    const commit = vi.fn(() => {
      if (failure === "publication") throw new Error("injected publication failure");
    });
    const { index, db, path, fs } = await fixture({
      prepare: (_old, next) => {
        target = next;
      },
      commit,
    });
    const original = readFileSync(path);
    const snapshot = index.snapshot();
    if (failure === "write" || failure === "zero-write") {
      vi.mocked(writeSync)
        .mockImplementationOnce(fs.writeSync)
        .mockImplementationOnce(fs.writeSync)
        .mockImplementationOnce(() => {
          if (failure === "zero-write") return 0;
          throw new Error("injected write failure");
        });
    }
    if (failure === "fsync")
      vi.mocked(fsyncSync).mockImplementationOnce(() => {
        throw new Error("injected fsync failure");
      });
    if (failure === "directory-sync") {
      if (process.platform === "win32") return;
      vi.mocked(fsyncSync)
        .mockImplementationOnce(fs.fsyncSync)
        .mockImplementationOnce(() => {
          throw new Error("injected directory sync failure");
        });
    }
    if (failure === "index") {
      db.exec(`CREATE TRIGGER fail_batch_index AFTER INSERT ON transcript_entries
        WHEN NEW.entry_id='new-2' BEGIN SELECT RAISE(ABORT, 'injected index failure'); END`);
    }
    if (failure === "flush")
      vi.spyOn(HistoryIndex.prototype, "flush").mockImplementationOnce(() => {
        throw new Error("injected flush failure");
      });
    function* source(): Iterable<SessionEntry> {
      yield entry(1);
      if (failure === "iterator") throw new Error("injected iterator failure");
      if (failure === "validation") yield { ...entry(2), parentId: "missing" };
      else if (failure === "duplicate") yield { ...entry(1), parentId: "new-1" };
      else if (failure === "compaction")
        yield {
          type: "compaction",
          id: "new-2",
          parentId: "new-1",
          timestamp: new Date(1).toISOString(),
          firstKeptEntryId: "absent",
          summary: "summary",
          tokensBefore: 1,
          systemMessage: { role: "system", content: "", timestamp: 1 },
        };
      else yield entry(2);
    }
    expect(() => index.replace(index.getHeader(), source())).toThrow(
      failure === "compaction" ? "Missing compaction retained boundary" : undefined,
    );
    expect(index.path).toBe(path);
    expect(readFileSync(path)).toEqual(original);
    expect(index.getTail(snapshot)?.entry).toMatchObject({ id: "new-0" });
    expect(index.snapshot()).toEqual(snapshot);
    if (failure !== "publication") expect(commit).not.toHaveBeenCalled();
    if (!["publication", "directory-sync"].includes(failure)) {
      expect(db.prepare("SELECT count(*) AS n FROM transcript_entries WHERE path<>?").get(index.key)?.n).toBe(
        0,
      );
      expect(db.prepare("SELECT count(*) AS n FROM transcript_state WHERE path<>?").get(index.key)?.n).toBe(
        0,
      );
    }
    // Reopening the authoritative locator must not inspect or accidentally activate target's partial bytes.
    expect(target).not.toBe(path);
    const reopened = new HistoryIndex(path, db);
    await reopened.load();
    expect(reopened.getTail(reopened.snapshot())?.entry).toMatchObject({ id: "new-0" });
  });
}

it("handles short writes without losing multi-byte text and leaves normal appends individually durable", async () => {
  const { index, fs, db } = await fixture();
  vi.mocked(writeSync).mockImplementation(((
    fd: number,
    buffer: NodeJS.ArrayBufferView | string,
    offset = 0,
  ) => {
    if (typeof buffer === "string") return fs.writeSync(fd, buffer);
    return fs.writeSync(fd, buffer, offset, Math.min(7, buffer.byteLength - (offset ?? 0)));
  }) as typeof writeSync);
  index.replace(index.getHeader(), [entry(1), entry(2)]);
  const reopened = new HistoryIndex(index.path, db);
  await reopened.load();
  expect(reopened.getTail(reopened.snapshot())?.entry).toMatchObject({
    message: { content: "message 2 中文" },
  });
  vi.mocked(fsyncSync).mockClear();
  reopened.append(entry(3));
  expect(fsyncSync).toHaveBeenCalledOnce();
});

it("publishes empty histories and preserves remapped compactions and attachment content on restart", async () => {
  const { index, db, dir } = await fixture();
  index.replace(index.getHeader(), []);
  expect(index.snapshot().endSeq).toBe(0);
  const empty = new HistoryIndex(index.path, db);
  await empty.load();
  expect(empty.snapshot().endSeq).toBe(0);
  const source = SessionManager.inMemory(dir);
  source.appendMessage({ role: "user", content: "old", timestamp: 1 });
  const kept = source.appendMessage({
    role: "user",
    content: [
      { type: "text", text: "retained" },
      { type: "image", mimeType: "image/png", data: "aGVsbG8=" },
    ],
    timestamp: 2,
  });
  source.appendCompaction("summary", kept);
  const manager = SessionManager.fromStore(index);
  manager.replaceEntries(source.iterateEntries());
  const reopened = new HistoryIndex(index.path, db);
  await reopened.load();
  const restored = SessionManager.fromStore(reopened);
  const values = [...restored.iterateEntries()];
  expect(values.map((value) => value.id)).not.toContain(kept);
  expect(values[2]).toMatchObject({ type: "compaction", firstKeptEntryId: values[1].id });
  expect(restored.buildSessionContext()).toEqual(source.buildSessionContext());
});

it("rejects oversized headers before publishing an unreadable generation", async () => {
  const commit = vi.fn();
  const { index, path } = await fixture({ prepare: vi.fn(), commit });
  const original = readFileSync(path);
  expect(() => index.replace({ ...index.getHeader(), cwd: "x".repeat(maxSessionEntryBytes) }, [])).toThrow(
    "Header exceeds",
  );
  expect(commit).not.toHaveBeenCalled();
  expect(index.path).toBe(path);
  expect(readFileSync(path)).toEqual(original);
});
