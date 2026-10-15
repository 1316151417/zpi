import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { stateMigrations } from "../src/main/state-migrations.ts";
import { stateSchemaV1 } from "../src/main/state-schema-v1.ts";
import { STATE_SCHEMA_VERSION, StateStore, validateStateDatabase } from "../src/main/state-store.ts";
import { transcriptSchemaV1 } from "../src/main/transcript-schema.ts";

const disposals: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dispose of disposals.splice(0).reverse()) dispose();
});
function legacy(projections = true) {
  const dir = mkdtempSync(join(tmpdir(), "zpi-schema-upgrade-"));
  disposals.push(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "state.sqlite");
  const db = new DatabaseSync(file);
  db.exec(stateSchemaV1);
  if (projections) db.exec(transcriptSchemaV1);
  db.exec("INSERT INTO schema_migrations VALUES (1,123); PRAGMA user_version=1;");
  db.prepare("INSERT INTO tasks(id,title,created_at,updated_at,data) VALUES (?,?,?,?,?)").run(
    "task",
    "retained",
    1,
    2,
    JSON.stringify({
      id: "task",
      title: "retained",
      projectId: null,
      createdAt: 1,
      updatedAt: 2,
      archivedAt: 3,
      sessionFile: "agent/sessions/task.jsonl",
    }),
  );
  db.exec(`INSERT INTO drafts VALUES ('task',4,'{"revision":4,"text":"draft survives"}');
    INSERT INTO queue_state VALUES ('task','{"autoDrain":false}');
    INSERT INTO storage_operations VALUES ('op','task','replace','blocked','{"operationId":"op"}');`);
  if (projections) db.exec("INSERT INTO transcript_search VALUES ('path',1,'run','search survives')");
  db.close();
  return file;
}
function open(file: string) {
  const state = new StateStore(file);
  disposals.push(() => state.close());
  return state;
}
it.each([true, false])(
  "upgrades released v1 with projections=%s, retains data and reopens idempotently",
  (projections) => {
    const file = legacy(projections);
    validateStateDatabase(file);
    const state = open(file);
    expect(state.getTask("task")).toMatchObject({
      id: "task",
      title: "retained",
      archivedAt: 3,
      revision: 1,
    });
    expect(state.getDraft("task")).toEqual({ revision: 4, text: "draft survives" });
    expect(state.getQueue("task")).toEqual({ autoDrain: false, items: [] });
    expect(state.listIntents()).toEqual([{ operationId: "op" }]);
    if (projections)
      expect(state.db.prepare("SELECT text FROM transcript_search").get()?.text).toBe("search survives");
    const ledger = state.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
    expect(ledger.map((row) => row.version)).toEqual([1, 2, 3]);
    expect(ledger[0].applied_at).toBe(123);
    for (const row of ledger) {
      expect(row.checksum).toMatch(/^[a-f0-9]{64}$/);
      expect(row.schema_hash).toMatch(/^[a-f0-9]{64}$/);
    }
    state.close();
    const reopened = open(file);
    expect(reopened.db.prepare("SELECT * FROM schema_migrations ORDER BY version").all()).toEqual(ledger);
    expect(reopened.db.prepare("PRAGMA user_version").get()?.user_version).toBe(STATE_SCHEMA_VERSION);
    validateStateDatabase(file, "full");
  },
);
it("upgrades an intermediate version without reapplying earlier migrations", () => {
  const file = legacy();
  const latest = open(file);
  const ledger = latest.db.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all();
  latest.close();
  const other = legacy();
  const db = new DatabaseSync(other);
  db.exec(stateMigrations[1]);
  db.exec("DELETE FROM schema_migrations; PRAGMA user_version=2;");
  for (const row of ledger)
    db.prepare("INSERT INTO schema_migrations VALUES (?,?,?,?)").run(
      row.version,
      row.applied_at,
      row.checksum,
      row.schema_hash,
    );
  db.close();
  const upgraded = open(other);
  expect(
    upgraded.db.prepare("SELECT * FROM schema_migrations WHERE version<=2 ORDER BY version").all(),
  ).toEqual(ledger);
  expect(upgraded.getDraft("task")).toMatchObject({ text: "draft survives" });
});
it("backfills deletion cleanup and invalidates incomplete legacy projection watermarks", () => {
  const file = legacy();
  const db = new DatabaseSync(file);
  db.exec(`UPDATE tasks SET deleted_at=99 WHERE id='task';
    INSERT INTO transcript_state VALUES ('path','generation','{}',1,1,'inode',0,NULL,'',0,0,NULL);
    DROP TABLE transcript_anchors;`);
  db.close();
  const state = open(file);
  expect(state.getTask("task")).toBeUndefined();
  expect(state.pendingCleanup()).toEqual([{ kind: "task", taskId: "task", path: "" }]);
  expect(state.db.prepare("SELECT * FROM transcript_state").all()).toEqual([]);
  expect(state.db.prepare("SELECT text FROM transcript_search").get()?.text).toBe("search survives");
});
it("rolls back all pending versions, schema changes and ledger entries on a late migration failure", () => {
  const file = legacy();
  const exec = DatabaseSync.prototype.exec;
  const spy = vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (this: DatabaseSync, sql) {
    if (this.location() && sql.startsWith("CREATE TABLE storage_cleanup"))
      throw new Error("injected migration failure");
    return exec.call(this, sql);
  });
  expect(() => new StateStore(file)).toThrow("injected migration failure");
  spy.mockRestore();
  const db = new DatabaseSync(file);
  expect(db.prepare("PRAGMA user_version").get()?.user_version).toBe(1);
  expect(db.prepare("SELECT * FROM schema_migrations").all()).toEqual([{ version: 1, applied_at: 123 }]);
  expect(
    db
      .prepare("SELECT name FROM sqlite_master WHERE name IN ('transcript_calls_open','storage_cleanup')")
      .all(),
  ).toEqual([]);
  expect(db.prepare("SELECT data FROM drafts").get()?.data).toContain("draft survives");
  db.close();
  expect(open(file).getTask("task")?.archivedAt).toBe(3);
});
it.each([
  "PRAGMA user_version=999",
  "ALTER TABLE tasks ADD COLUMN unexpected TEXT",
  "ALTER TABLE transcript_calls ADD COLUMN unexpected TEXT",
  "CREATE TRIGGER unexpected AFTER DELETE ON tasks BEGIN DELETE FROM projects; END",
  "UPDATE schema_migrations SET checksum='modified' WHERE version=1",
  "UPDATE schema_migrations SET schema_hash='modified' WHERE version=2",
  "DELETE FROM schema_migrations WHERE version=2",
])("rejects incompatible versions, definitions and ledgers without modifying the database: %s", (sql) => {
  const file = legacy();
  const state = open(file);
  state.db.exec(sql);
  state.close();
  const bytes = readFileSync(file);
  expect(() => new StateStore(file)).toThrow(/schema/);
  expect(readFileSync(file)).toEqual(bytes);
});
it("keeps the released v1 SQL frozen", () => {
  expect(createHash("sha256").update(stateSchemaV1).digest("hex")).toBe(
    "ad056b19e25a71f8af0f6137da2f056f31b8e2510071dc48ca82ff00a0dcab2e",
  );
});
