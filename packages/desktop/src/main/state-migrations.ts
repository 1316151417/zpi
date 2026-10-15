import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { stateSchemaV1 } from "./state-schema-v1.ts";
import {
  ensureTranscriptSchema,
  transcriptIndexesV2,
  transcriptSchemaV1,
  transcriptTables,
} from "./transcript-schema.ts";

// Append only. Checksums cover the exact migration SQL; schema hashes cover its resulting definitions.
export const stateMigrations = [
  stateSchemaV1,
  `ALTER TABLE schema_migrations ADD COLUMN checksum TEXT;
ALTER TABLE schema_migrations ADD COLUMN schema_hash TEXT;
${transcriptSchemaV1}
${transcriptIndexesV2}`,
  `CREATE TABLE storage_cleanup(kind TEXT NOT NULL CHECK(kind IN ('task','transcript')),
task_id TEXT NOT NULL, path TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, last_error TEXT,
PRIMARY KEY(kind,task_id,path));
INSERT INTO storage_cleanup(kind,task_id,path) SELECT 'task',id,'' FROM tasks WHERE deleted_at IS NOT NULL;`,
] as const;
export const STATE_SCHEMA_VERSION = stateMigrations.length;
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function definitions(db: DatabaseSync): Map<string, string> {
  return new Map(
    db
      .prepare("SELECT name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((row) => [String(row.name), String(row.sql)]),
  );
}
const schemas = new Map<number, Map<string, string>>();
function schemaAt(version: number): Map<string, string> {
  let schema = schemas.get(version);
  if (!schema) {
    const reference = new DatabaseSync(":memory:");
    try {
      for (const sql of stateMigrations.slice(0, version)) reference.exec(sql);
      // v1 created projections lazily. Their presence is optional, their definitions are frozen.
      if (version === 1) reference.exec(transcriptSchemaV1);
      schema = definitions(reference);
      schemas.set(version, schema);
    } finally {
      reference.close();
    }
  }
  return schema;
}
function schemaHash(version: number): string {
  return hash(JSON.stringify([...schemaAt(version)].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))));
}
function validate(db: DatabaseSync): number {
  const version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
  if (version === 0) throw new Error("storage: unversioned database; use offline migration");
  if (version < 1 || version > STATE_SCHEMA_VERSION)
    throw new Error(`storage: unsupported schema version ${version}`);
  const actual = definitions(db);
  const expected = schemaAt(version);
  for (const [name, sql] of expected) {
    // Missing projections can be regenerated from JSONL; never repair authoritative tables.
    if (name.startsWith("transcript_") && !actual.has(name)) continue;
    if (actual.get(name) !== sql) throw new Error(`storage: invalid authoritative schema: ${name}`);
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) throw new Error(`storage: unexpected schema object: ${name}`);
  }
  const ledger = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  if (ledger.length !== version) throw new Error("storage: invalid schema migration ledger length");
  for (let i = 0; i < version; i++) {
    const row = ledger[i];
    if (row.version !== i + 1 || !Number.isSafeInteger(row.applied_at) || Number(row.applied_at) < 0)
      throw new Error(`storage: invalid schema migration ledger at version ${i + 1}`);
    if (version >= 2 && (row.checksum !== hash(stateMigrations[i]) || row.schema_hash !== schemaHash(i + 1)))
      throw new Error(`storage: schema migration checksum mismatch at version ${i + 1}`);
  }
  return version;
}

/** Read-only preflight accepts supported historical versions without upgrading them. */
export function validateStateDatabase(path: string, mode: "schema" | "full" = "schema"): void {
  if (!lstatSync(path).isFile()) throw new Error("storage: state database must be a regular file");
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    validate(db);
    if (
      mode === "full" &&
      (db
        .prepare("PRAGMA integrity_check")
        .all()
        .some((row) => row.integrity_check !== "ok") ||
        db.prepare("PRAGMA foreign_key_check").all().length)
    )
      throw new Error("storage: authoritative database integrity check failed");
  } finally {
    db.close();
  }
}

/** All pending versions, their ledger entries and user_version commit together or all roll back. */
export function migrateStateDatabase(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    let version = Number(db.prepare("PRAGMA user_version").get()?.user_version);
    if (version === 0) {
      if (definitions(db).size) throw new Error("storage: unversioned database; use offline migration");
    } else version = validate(db);
    for (let next = version + 1; next <= STATE_SCHEMA_VERSION; next++) {
      const missingProjection =
        next === 2 &&
        transcriptTables.some(
          (table) =>
            !db
              .prepare("SELECT 1 FROM sqlite_master WHERE name=? AND type='table'")
              .get(`transcript_${table}`),
        );
      db.exec(stateMigrations[next - 1]);
      if (missingProjection) db.exec("DELETE FROM transcript_state");
      if (next === 1) {
        db.prepare("INSERT INTO schema_migrations(version,applied_at) VALUES (?,?)").run(next, Date.now());
      } else {
        if (next === 2) {
          // Backfill only the validated released v1 ledger, preserving its original application time.
          db.prepare("UPDATE schema_migrations SET checksum=?,schema_hash=? WHERE version=1").run(
            hash(stateMigrations[0]),
            schemaHash(1),
          );
        }
        db.prepare(
          "INSERT INTO schema_migrations(version,applied_at,checksum,schema_hash) VALUES (?,?,?,?)",
        ).run(next, Date.now(), hash(stateMigrations[next - 1]), schemaHash(next));
      }
      db.exec(`PRAGMA user_version=${next}`);
      validate(db);
    }
    ensureTranscriptSchema(db);
    db.exec("COMMIT");
  } catch (cause) {
    db.exec("ROLLBACK");
    throw new Error(
      `storage: schema upgrade failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}
