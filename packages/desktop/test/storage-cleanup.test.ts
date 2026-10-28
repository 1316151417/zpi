import { existsSync, readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it, vi } from "vitest";
import { done } from "../../../tests/fake-server.ts";
import type { WorkerHistoryIndex as HistoryIndex } from "../src/main/history-storage.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { retryStorageCleanup } from "../src/main/storage-cleanup.ts";
import { transcriptTables } from "../src/main/transcript-schema.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

function history(host: SessionHost, id: string): HistoryIndex {
  const index = (host as unknown as { indexes: Map<string, HistoryIndex> }).indexes.get(id);
  if (!index) throw new Error("missing history fixture");
  return index;
}
async function append(index: HistoryIndex, id: string) {
  await index.appendAsync({
    id: `${id}-run`,
    parentId: index.data.parentId,
    type: "custom",
    timestamp: new Date().toISOString(),
    customType: "zpi.run",
    data: { runId: id, phase: "start", text: "retained search text" },
  });
  await index.appendAsync({
    id,
    parentId: index.data.parentId,
    type: "message",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: "retained search text", timestamp: 1 },
  });
}
async function reopen(f: Awaited<ReturnType<typeof fixture>>) {
  await f.host.close();
  const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => host.close());
  await host.init();
  return host;
}
it("retains archived transcripts/search, then deletes every generation and all transcript projections", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const other = await f.host.createSession(f.a.id);
  const index = history(f.host, task.id);
  await append(index, "first");
  await append(history(f.host, other.id), "other");
  const oldPath = index.path;
  const oldKey = index.key;
  await index.replaceAsync(index.getHeader(), [
    {
      type: "message",
      id: "new",
      parentId: null,
      timestamp: new Date().toISOString(),
      message: { role: "user", content: "new generation", timestamp: 2 },
    },
  ]);
  const currentPath = index.path;
  const currentKey = index.key;
  const orphanKey = join(
    dirname(currentKey),
    `${task.id}.generation-11111111-1111-1111-1111-111111111111.jsonl`,
  );
  const files = [oldPath, currentPath];
  const db = new DatabaseSync(join(f.dir, "history.sqlite"));
  cleanup.push(async () => db.close());
  db.prepare("INSERT INTO transcript_search VALUES (?,?,?,?)").run(
    orphanKey,
    1,
    "orphan",
    "index without file/watermark",
  );
  // Exercise even projections not produced by this small conversation.
  db.prepare("INSERT INTO transcript_calls VALUES (?,?,?,?,?,?,?)").run(oldKey, 7, "r", 0, 1, 2, 0);
  db.prepare("INSERT INTO transcript_runs VALUES (?,?,?,?,?,?,?,?,?,?,?)").run(
    oldKey,
    "r",
    1,
    2,
    3,
    4,
    0,
    0,
    null,
    null,
    null,
  );
  db.prepare("INSERT INTO transcript_checkpoints VALUES (?,?,?)").run(oldKey, 7, "{}");
  db.prepare("INSERT INTO transcript_journals VALUES (?,?,?,?,?)").run(oldKey, "j", 7, null, 0);
  db.prepare("INSERT INTO transcript_pending_journals VALUES (?,?,?,?)").run(oldKey, "j", 7, null);
  const before = db.prepare("SELECT * FROM transcript_search ORDER BY path,seq").all();
  await f.host.archiveSession(task.id);
  expect(f.settings.state.getTask(task.id)?.archivedAt).toBeTypeOf("number");
  expect(db.prepare("SELECT * FROM transcript_search ORDER BY path,seq").all()).toEqual(before);
  for (const file of files) expect(existsSync(file)).toBe(true);
  await f.host.deleteSession(task.id);
  for (const file of files) expect(existsSync(file)).toBe(false);
  for (const table of transcriptTables)
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM transcript_${table} WHERE path IN (?,?)`).get(oldKey, currentKey)
        ?.n,
    ).toBe(0);
  expect(db.prepare("SELECT * FROM transcript_search WHERE path=?").all(orphanKey)).toEqual([]);
  expect(existsSync(f.host.sessionPath(other.id))).toBe(true);
  expect(db.prepare("SELECT COUNT(*) AS n FROM transcript_search").get()?.n).toBeGreaterThan(0);
  expect(f.settings.state.pendingCleanup()).toEqual([]);
});
it("retries persisted resource and transcript-index failures after restart without resurrecting the task", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const index = history(f.host, task.id);
  await append(index, "content");
  const path = index.path;
  // A released installation can also leave projections in the old shared state database.
  f.settings.state.db
    .prepare("INSERT INTO transcript_entries VALUES (?,?,?,?,?,?,?,?,?,?)")
    .run(index.key, 1, "legacy", "message", "user", 0, 1, null, 0, null);
  f.settings.state.db.exec(`CREATE TRIGGER fail_cleanup BEFORE DELETE ON transcript_entries
    BEGIN SELECT RAISE(ABORT,'injected cleanup failure'); END;`);
  const failure = vi
    .spyOn(f.host.attachments, "deleteSession")
    .mockRejectedValue(new Error("attachment failure"));
  await f.host.deleteSession(task.id);
  expect(f.settings.state.getTask(task.id)).toBeUndefined();
  expect(
    f.settings.state.db.prepare("SELECT attempts,last_error FROM storage_cleanup ORDER BY kind").all(),
  ).toEqual([
    { attempts: 1, last_error: "attachment failure" },
    { attempts: 1, last_error: "injected cleanup failure" },
  ]);
  expect(existsSync(path)).toBe(false); // Retry must also remove indexes when the file is already gone.
  failure.mockRestore();
  f.settings.state.db.exec("DROP TRIGGER fail_cleanup");
  const host = await reopen(f);
  expect(host.listSessions(f.a.id)).toEqual([]);
  expect(f.settings.state.pendingCleanup()).toEqual([]);
  expect(f.settings.state.db.prepare("SELECT COUNT(*) AS n FROM transcript_search").get()?.n).toBe(0);
});
it("protects current/archived task paths and unresolved recovery generations until references are released", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const index = history(f.host, task.id);
  const original = index.path;
  const originalKey = index.key;
  await index.replaceAsync(index.getHeader(), []);
  const current = index.path;
  const state = f.settings.state;
  state.db.prepare("UPDATE transcript_state SET path=? WHERE path=?").run(original, originalKey);
  state.db.prepare("INSERT INTO transcript_search VALUES (?,?,?,?)").run(original, 1, "r", "legacy alias");
  state.enqueueCleanup("transcript", task.id, relative(f.dir, current));
  state.putIntent({
    operationId: "recovery",
    taskId: task.id,
    kind: "replace",
    stage: "blocked",
    targetFile: relative(f.dir, original),
  });
  await f.host.archiveSession(task.id);
  const errors: unknown[] = [];
  const retry = () =>
    retryStorageCleanup(
      state,
      f.dir,
      async () => {},
      (error) => errors.push(error),
    );
  await retry();
  expect(existsSync(original)).toBe(true);
  expect(existsSync(current)).toBe(true);
  expect(state.pendingCleanup()).toHaveLength(2);
  state.completeIntent("recovery");
  await retry();
  expect(existsSync(original)).toBe(false);
  expect(state.db.prepare("SELECT * FROM transcript_search WHERE path=?").all(original)).toEqual([]);
  expect(existsSync(current)).toBe(true);
  expect(state.pendingCleanup()).toHaveLength(1);
  expect(errors).toHaveLength(3);
});
it("preserves mismatched generations and external files, recording a retryable diagnostic", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const other = await f.host.createSession(f.a.id);
  const foreign = join(
    dirname(f.host.sessionPath(task.id)),
    `${task.id}.generation-00000000-0000-0000-0000-000000000000.jsonl`,
  );
  const bytes = readFileSync(f.host.sessionPath(other.id));
  await writeFile(foreign, bytes);
  const outside = join(f.dir, "outside.jsonl");
  await writeFile(outside, bytes);
  f.settings.state.enqueueCleanup("transcript", task.id, outside);
  await f.host.deleteSession(task.id);
  expect(readFileSync(foreign)).toEqual(bytes);
  expect(readFileSync(outside)).toEqual(bytes);
  expect(f.settings.state.pendingCleanup()).toHaveLength(2);
});
it("retries file removal failures without discarding archived/current data", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const file = f.host.sessionPath(task.id);
  await rename(file, `${file}.saved`);
  await mkdir(file);
  await f.host.deleteSession(task.id);
  expect(f.settings.state.pendingCleanup().some((job) => job.taskId === task.id)).toBe(true);
  const { rm } = await import("node:fs/promises");
  await rm(file, { recursive: true });
  await rename(`${file}.saved`, file);
  await reopen(f);
  expect(existsSync(file)).toBe(false);
  expect(f.settings.state.pendingCleanup()).toEqual([]);
});
it("reports bad task fields before startup mutates valid task state", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const other = await f.host.createSession(f.a.id);
  await f.host.close();
  const before = f.settings.state.getTask(other.id);
  const bad = JSON.stringify({ ...f.settings.state.getTask(task.id), title: 42 });
  f.settings.state.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(bad, task.id);
  const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => host.close());
  await expect(host.init()).rejects.toThrow(`invalid task "${task.id}": title`);
  expect(f.settings.state.getTask(other.id)).toEqual(before);
  expect(f.settings.state.db.prepare("SELECT data FROM tasks WHERE id=?").get(task.id)?.data).toBe(bad);
});
it("keeps a task with a missing transcript locator visible with an explicit diagnostic", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  const state = f.settings.state;
  const saved = state.getTask(task.id);
  if (!saved) throw new Error("missing task");
  delete saved.sessionFile;
  state.db.prepare("UPDATE tasks SET data=? WHERE id=?").run(JSON.stringify(saved), task.id);
  const host = await reopen(f);
  expect(host.listArchivedSessions().find((record) => record.id === task.id)?.diagnostic).toContain(
    "Missing task transcript location",
  );
  expect(state.getTask(task.id)?.sessionFile).toBeUndefined();
});
