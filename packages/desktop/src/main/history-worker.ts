import { closeSync, openSync, rmSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { SessionEntry, SessionHeader } from "zpi-coding-agent";
import { maxSessionEntryBytes, SessionManager } from "zpi-coding-agent";
import { remapSessionEntries } from "../../../coding-agent/src/core/session-manager.ts";
import { HistoryIndex } from "./history-index.ts";
import { readTranscriptEntries } from "./transcript-copy.ts";
import {
  deleteTranscriptIndex,
  ensureTranscriptSchema,
  transcriptPathKey,
  transcriptTables,
} from "./transcript-schema.ts";

export type HistoryCommand =
  | { type: "init" | "close" }
  | { type: "load" | "flush" | "forget"; path: string }
  | { type: "forget-task"; taskId: string }
  | { type: "create"; path: string; header: SessionHeader }
  | { type: "append"; path: string; entry: SessionEntry }
  | { type: "stage-start"; token: string; path: string; header: SessionHeader; remapIds?: boolean }
  | { type: "stage-entry"; token: string; entry: SessionEntry }
  | { type: "stage-finish" | "stage-cancel"; token: string };

const db = new DatabaseSync((workerData as { database: string }).database);
db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000");
ensureTranscriptSchema(db);
const indexes = new Map<string, HistoryIndex>();
const stages = new Map<
  string,
  { path: string; spool: string; fd: number; header: SessionHeader; remapIds?: boolean }
>();
const write = (fd: number, bytes: Buffer) => {
  let offset = 0;
  while (offset < bytes.length) {
    const count = writeSync(fd, bytes, offset);
    if (!count) throw new Error("storage: Transcript spool write made no progress");
    offset += count;
  }
};
async function indexAt(path: string) {
  let index = indexes.get(path);
  if (!index) {
    index = new HistoryIndex(path, db);
    await index.load();
    indexes.set(path, index);
  }
  return index;
}
function cancelStage(token: string) {
  const stage = stages.get(token);
  if (!stage) return;
  stages.delete(token);
  try {
    closeSync(stage.fd);
  } finally {
    rmSync(stage.spool, { force: true });
  }
}
function deleteIndexes(paths: Iterable<string>): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const path of paths) deleteTranscriptIndex(db, path);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
async function execute(command: HistoryCommand): Promise<unknown> {
  switch (command.type) {
    case "init":
      return;
    case "create": {
      const index = HistoryIndex.create(command.path, db, command.header);
      indexes.set(command.path, index);
      return index.publishedMetadata();
    }
    case "load": {
      const index = new HistoryIndex(command.path, db);
      await index.load();
      // Recovery also persists its interrupted tool facts on this thread, before readers open.
      SessionManager.fromStore(index);
      indexes.set(command.path, index);
      return index.publishedMetadata();
    }
    case "append": {
      const index = await indexAt(command.path);
      index.append(command.entry);
      return index.publishedMetadata();
    }
    case "flush": {
      const index = await indexAt(command.path);
      index.flush();
      return index.publishedMetadata();
    }
    case "forget":
      deleteIndexes([transcriptPathKey(db, command.path)]);
      indexes.delete(command.path);
      return;
    case "forget-task": {
      const paths = new Set<string>();
      for (const row of db
        .prepare("SELECT path FROM transcript_state WHERE json_extract(header,'$.id')=?")
        .all(command.taskId))
        paths.add(String(row.path));
      for (const index of indexes.values()) {
        if (index.getHeader().id !== command.taskId) continue;
        paths.add(index.key);
      }
      for (const parent of new Set([...paths].map(dirname))) {
        const prefix = join(parent, `${command.taskId}.`);
        for (const table of transcriptTables)
          for (const row of db
            .prepare(`SELECT DISTINCT path FROM transcript_${table} WHERE path>=? AND path<?`)
            .all(prefix, `${prefix}\uffff`)) {
            const path = String(row.path),
              name = basename(path);
            if (
              name === `${command.taskId}.jsonl` ||
              (name.startsWith(`${command.taskId}.generation-`) &&
                /^[0-9a-f-]{36}\.jsonl$/.test(name.slice(`${command.taskId}.generation-`.length)))
            )
              paths.add(path);
          }
      }
      deleteIndexes(paths);
      for (const [path, index] of indexes) if (index.getHeader().id === command.taskId) indexes.delete(path);
      return;
    }
    case "stage-start": {
      const spool = `${command.path}.${command.token}.entries.tmp`;
      stages.set(command.token, { ...command, spool, fd: openSync(spool, "wx", 0o600) });
      return;
    }
    case "stage-entry": {
      const stage = stages.get(command.token);
      if (!stage) throw new Error("storage: Missing transcript stage");
      const bytes = Buffer.from(`${JSON.stringify(command.entry)}\n`);
      if (bytes.length - 1 > maxSessionEntryBytes) throw new Error("storage: Entry exceeds 8 MiB");
      write(stage.fd, bytes);
      return;
    }
    case "stage-finish": {
      const stage = stages.get(command.token);
      if (!stage) throw new Error("storage: Missing transcript stage");
      stages.delete(command.token);
      closeSync(stage.fd);
      try {
        const entries = readTranscriptEntries(stage.spool);
        const index = HistoryIndex.stageGeneration(
          stage.path,
          db,
          stage.header,
          stage.remapIds ? remapSessionEntries(entries) : entries,
        );
        indexes.set(stage.path, index);
        return index.publishedMetadata();
      } catch (error) {
        deleteTranscriptIndex(db, transcriptPathKey(db, stage.path));
        rmSync(stage.path, { force: true });
        throw error;
      } finally {
        rmSync(stage.spool, { force: true });
      }
    }
    case "stage-cancel":
      cancelStage(command.token);
      return;
    case "close":
      for (const token of stages.keys()) cancelStage(token);
      db.close();
      return;
  }
}
// A single writer serializes operations without ever blocking Electron on a SQLite writer lock.
let queue = Promise.resolve();
parentPort?.on("message", ({ id, command }: { id: number; command: HistoryCommand }) => {
  queue = queue.then(async () => {
    try {
      parentPort?.postMessage({ id, result: await execute(command) });
    } catch (error) {
      parentPort?.postMessage({ id, error: error instanceof Error ? error.message : String(error) });
    }
    if (command.type === "close") parentPort?.close();
  });
});
