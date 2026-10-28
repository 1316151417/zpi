import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type { Worker } from "node:worker_threads";
import { afterEach, expect, it, vi } from "vitest";
import { type SessionEntry, SessionManager } from "zpi-coding-agent";
import { HistoryStorage } from "../src/main/history-storage.ts";

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-history-worker-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const storage = new HistoryStorage(join(dir, "history.sqlite"));
  cleanup.push(() => storage.close());
  const prepare = vi.fn(),
    commit = vi.fn();
  const index = await storage.open(
    join(dir, "task.jsonl"),
    { prepare, commit },
    {
      type: "session",
      version: 2,
      format: "zpi",
      id: "task",
      cwd: dir,
      timestamp: new Date().toISOString(),
    },
  );
  const manager = SessionManager.fromStore(index);
  return { dir, storage, index, manager, prepare, commit };
}
function entry(id: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: new Date().toISOString(),
    message: { role: "user", content: id, timestamp: 1 },
  };
}

it("keeps main metadata and timers responsive while durable history acknowledgement is blocked", async () => {
  const { dir, index, manager } = await fixture();
  const lock = new DatabaseSync(join(dir, "history.sqlite"));
  const state = new DatabaseSync(join(dir, "state.sqlite"));
  cleanup.push(() => {
    lock.close();
    state.close();
  });
  state.exec("CREATE TABLE metadata(value INTEGER)");
  const published = vi.fn();
  manager.subscribeEntries(published);
  const before = index.snapshot();
  lock.exec("BEGIN IMMEDIATE");
  const pending = manager.appendMessageAsync({ role: "user", content: "durable", timestamp: 1 });
  try {
    await delay(50);
    // A separate database avoids transferring the worker's writer lock back to main.
    state.prepare("INSERT INTO metadata VALUES (?)").run(42);
    expect(state.prepare("SELECT value FROM metadata").get()?.value).toBe(42);
    expect(index.snapshot()).toEqual(before);
    expect(published).not.toHaveBeenCalled();
  } finally {
    lock.exec("ROLLBACK");
  }
  await pending;
  expect(index.snapshot().endSeq).toBe(1);
  expect(published).toHaveBeenCalledOnce();
  expect(await readFile(index.path, "utf8")).toContain("durable");
  expect(index.getTail(index.snapshot())?.entry).toMatchObject({ message: { content: "durable" } });
});

it("serializes concurrent appends and publishes only a complete durable parent chain", async () => {
  const { storage, index, manager } = await fixture();
  const ids = await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      manager.appendMessageAsync({ role: "user", content: `message ${i}`, timestamp: i }),
    ),
  );
  await manager.flushAsync();
  const reopened = await storage.open(index.path);
  const entries = [...reopened.readRange(1, 40, reopened.snapshot())].map(({ entry }) => entry);
  expect(entries.map((entry) => entry.id)).toEqual(ids);
  expect(entries.map((entry) => entry.parentId)).toEqual([null, ...ids.slice(0, -1)]);
});

it("does not pin a stale read transaction when checking the latest run before replacement", async () => {
  const { index, manager } = await fixture();
  await manager.appendCustomEntryAsync("zpi.run", { phase: "start", runId: "old", text: "old" });
  expect(index.latestRun()?.runId).toBe("old");
  await manager.replaceEntriesAsync([]);
  await manager.appendMessageAsync({ role: "user", content: "replacement", timestamp: 2 });
  expect(manager.buildSessionContext().messages).toMatchObject([{ content: "replacement" }]);
  expect(index.db.prepare("SELECT seq FROM transcript_state WHERE path=?").get(index.key)?.seq).toBe(1);
});

it("orders a concurrent append after bulk replacement in the same manager", async () => {
  const { index, manager } = await fixture();
  const replacement = manager.replaceEntriesAsync([entry("replacement")]);
  const append = manager.appendMessageAsync({ role: "user", content: "after replacement", timestamp: 2 });
  await Promise.all([replacement, append]);
  expect(index.snapshot().endSeq).toBe(2);
  expect(manager.buildSessionContext().messages).toMatchObject([
    { content: "replacement" },
    { content: "after replacement" },
  ]);
});

it("retains durable bytes after an index failure and recovers them once without accepting later writes", async () => {
  const { dir, storage, index, manager } = await fixture();
  const db = new DatabaseSync(join(dir, "history.sqlite"));
  cleanup.push(() => db.close());
  db.exec(
    "CREATE TRIGGER fail_append BEFORE INSERT ON transcript_entries BEGIN SELECT RAISE(ABORT,'index full'); END",
  );
  await expect(
    manager.appendMessageAsync({ role: "user", content: "saved once", timestamp: 1 }),
  ).rejects.toThrow("index full");
  expect(index.snapshot().endSeq).toBe(0);
  await expect(
    manager.appendMessageAsync({ role: "user", content: "never saved", timestamp: 2 }),
  ).rejects.toThrow("index full");
  db.exec("DROP TRIGGER fail_append");
  const recovered = await storage.open(index.path);
  expect(recovered.snapshot().endSeq).toBe(1);
  expect(await readFile(index.path, "utf8")).not.toContain("never saved");
  expect(recovered.getTail(recovered.snapshot())?.entry).toMatchObject({
    message: { content: "saved once" },
  });
});

it("retries cache cleanup atomically, including index-only generation remnants", async () => {
  const { dir, storage, index, manager } = await fixture();
  await manager.appendMessageAsync({ role: "user", content: "delete", timestamp: 1 });
  const db = new DatabaseSync(join(dir, "history.sqlite"));
  cleanup.push(() => db.close());
  const orphan = "task.generation-11111111-1111-1111-1111-111111111111.jsonl";
  db.prepare("INSERT INTO transcript_search VALUES (?,?,?,?)").run(orphan, 1, "r", "orphan");
  db.exec(
    "CREATE TRIGGER fail_delete BEFORE DELETE ON transcript_entries BEGIN SELECT RAISE(ABORT,'cleanup failed'); END",
  );
  await expect(storage.forgetTask("task")).rejects.toThrow("cleanup failed");
  expect(index.db.prepare("SELECT COUNT(*) AS n FROM transcript_state").get()?.n).toBe(1);
  db.exec("DROP TRIGGER fail_delete");
  await storage.forgetTask("task");
  expect(index.db.prepare("SELECT COUNT(*) AS n FROM transcript_state").get()?.n).toBe(0);
  expect(index.db.prepare("SELECT COUNT(*) AS n FROM transcript_search").get()?.n).toBe(0);
});

it("publishes a bulk generation only after completion and closes an abandoned source", async () => {
  const { index, manager, prepare, commit } = await fixture();
  await manager.appendMessageAsync({ role: "user", content: "old", timestamp: 1 });
  const oldPath = index.path,
    before = await readFile(oldPath);
  let finalized = false;
  function* broken() {
    try {
      yield entry("first");
      throw new Error("source failed");
    } finally {
      finalized = true;
    }
  }
  await expect(manager.replaceEntriesAsync(broken())).rejects.toThrow("source failed");
  expect(finalized).toBe(true);
  expect(index.path).toBe(oldPath);
  expect(await readFile(oldPath)).toEqual(before);
  expect(commit).not.toHaveBeenCalled();
  await manager.replaceEntriesAsync([entry("first"), entry("second", "first")]);
  expect(prepare).toHaveBeenCalledTimes(2);
  expect(commit).toHaveBeenCalledOnce();
  expect(index.path).not.toBe(oldPath);
  expect(index.snapshot().endSeq).toBe(2);
  expect(manager.buildSessionContext().messages).toMatchObject([{ content: "first" }, { content: "second" }]);
  expect(await readFile(oldPath)).toEqual(before);
});

it("rejects pending work when the worker exits and makes shutdown idempotent", async () => {
  const { dir, storage, index } = await fixture();
  const lock = new DatabaseSync(join(dir, "history.sqlite"));
  cleanup.push(() => lock.close());
  lock.exec("BEGIN IMMEDIATE");
  const worker = (storage as unknown as { worker: Worker }).worker;
  const pending = storage.request({ type: "append", path: index.path, entry: entry("pending") });
  const result = pending.catch((error: unknown) => error);
  await delay(20);
  const termination = worker.terminate();
  await delay(10);
  lock.exec("ROLLBACK");
  await termination;
  expect(await result).toBeInstanceOf(Error);
  await expect(storage.open(index.path)).rejects.toThrow("unavailable");
  await storage.close();
  await storage.close();
});
