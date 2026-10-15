import { realpathSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";

// Released projection schema. Keep stable for validating and upgrading v1 databases.
export const transcriptSchemaV1 = `
      CREATE TABLE IF NOT EXISTS transcript_state(path TEXT PRIMARY KEY, generation TEXT NOT NULL, header TEXT NOT NULL, size INTEGER NOT NULL, modified REAL NOT NULL, inode TEXT NOT NULL, seq INTEGER NOT NULL, parent_id TEXT, current_run TEXT NOT NULL, cache_read INTEGER NOT NULL, cache_input INTEGER NOT NULL, activity REAL);
      CREATE TABLE IF NOT EXISTS transcript_entries(path TEXT NOT NULL, seq INTEGER NOT NULL, entry_id TEXT NOT NULL, type TEXT NOT NULL, role TEXT, offset INTEGER NOT NULL, length INTEGER NOT NULL, run_id TEXT, file_change INTEGER NOT NULL, kept_seq INTEGER, PRIMARY KEY(path,seq), UNIQUE(path,entry_id));
      CREATE INDEX IF NOT EXISTS transcript_entries_type ON transcript_entries(path,type,seq);
      CREATE TABLE IF NOT EXISTS transcript_runs(path TEXT NOT NULL, run_id TEXT NOT NULL, start INTEGER NOT NULL, start_end INTEGER NOT NULL, end INTEGER, end_end INTEGER, ordinal INTEGER NOT NULL, auxiliary INTEGER NOT NULL, accepted_seq INTEGER, accepted_end INTEGER, queue_item_id TEXT, PRIMARY KEY(path,run_id));
      CREATE TABLE IF NOT EXISTS transcript_calls(path TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, complete INTEGER NOT NULL, PRIMARY KEY(path,seq));
      CREATE TABLE IF NOT EXISTS transcript_projections(path TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(path,key));
      CREATE TABLE IF NOT EXISTS transcript_checkpoints(path TEXT NOT NULL, seq INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(path,seq));
      CREATE TABLE IF NOT EXISTS transcript_journals(path TEXT NOT NULL, journal_id TEXT NOT NULL, seq INTEGER NOT NULL, anchor_id TEXT, committed INTEGER NOT NULL, PRIMARY KEY(path,journal_id,seq));
      CREATE TABLE IF NOT EXISTS transcript_anchors(path TEXT NOT NULL, offset INTEGER NOT NULL, value TEXT NOT NULL, PRIMARY KEY(path,offset));
      CREATE TABLE IF NOT EXISTS transcript_pending_journals(path TEXT NOT NULL, journal_id TEXT NOT NULL, first_seq INTEGER NOT NULL, anchor_id TEXT, PRIMARY KEY(path,journal_id));
      CREATE TABLE IF NOT EXISTS transcript_search(path TEXT NOT NULL, seq INTEGER NOT NULL, run_id TEXT NOT NULL, text TEXT NOT NULL, PRIMARY KEY(path,seq));
    `;

export const transcriptIndexesV2 = `
CREATE INDEX IF NOT EXISTS transcript_calls_open ON transcript_calls(path) WHERE complete=0;
CREATE INDEX IF NOT EXISTS transcript_runs_start ON transcript_runs(path,start);
`;

export const transcriptTables = [
  "state",
  "entries",
  "runs",
  "calls",
  "projections",
  "checkpoints",
  "journals",
  "search",
  "anchors",
  "pending_journals",
] as const;

/** Missing projections are rebuildable; existing incompatible definitions are rejected at startup. */
export function ensureTranscriptSchema(db: DatabaseSync): boolean {
  const missing = transcriptTables.some(
    (table) =>
      !db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(`transcript_${table}`),
  );
  db.exec(transcriptSchemaV1 + transcriptIndexesV2);
  if (missing) db.exec("DELETE FROM transcript_state");
  return missing;
}

export function deleteTranscriptIndex(db: DatabaseSync, path: string): void {
  for (const table of transcriptTables) db.prepare(`DELETE FROM transcript_${table} WHERE path=?`).run(path);
}

// SQLite resolves /var to /private/var on macOS. Use the same directory identity for file keys.
export function canonicalTranscriptPath(path: string): string {
  try {
    return resolve(realpathSync(dirname(path)), basename(path));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return resolve(path);
  }
}
export function transcriptPathKey(db: DatabaseSync, path: string): string {
  const location = db.location();
  return location ? relative(dirname(location), canonicalTranscriptPath(path)) : path;
}
