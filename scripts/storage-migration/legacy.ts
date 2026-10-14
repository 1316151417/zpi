/** Frozen v1 adapter. Never import legacy stores: opening them can mutate the source. */
import { createReadStream, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getCurrentTools, type SystemMessage } from "zpi-ai";

export type Row = Record<string, unknown>;
export interface LegacySession {
  header: Row;
  entries: LegacyEntries;
  close(): void;
  state: LegacyState;
  acceptedQueueIds: { has(id: string): boolean };
  counts: Record<string, number>;
  historicalSelection: { selection?: Row; lastThinkingLevel: unknown };
  lastTimestamp?: string;
}
/** Disposable disk-backed sequence; no full-history arrays or ID sets. */
export class LegacyEntries implements Iterable<Row> {
  readonly directory = mkdtempSync(join(tmpdir(), "zpi-legacy-spool-"));
  readonly db = new DatabaseSync(join(this.directory, "records.sqlite"));
  length = 0;
  private closed = false;
  constructor() {
    this.db.exec(`PRAGMA journal_mode=OFF; PRAGMA synchronous=OFF; PRAGMA temp_store=FILE; PRAGMA cache_size=-2048;
      CREATE TABLE entries(seq INTEGER PRIMARY KEY,id TEXT UNIQUE NOT NULL,data TEXT NOT NULL);
      CREATE TABLE journal_updates(journal_id TEXT NOT NULL,seq INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE INDEX journal_lookup ON journal_updates(journal_id,seq);
      CREATE TABLE accepted_queue(id TEXT PRIMARY KEY);
      CREATE TABLE current_state(key TEXT PRIMARY KEY,data TEXT NOT NULL);`);
  }
  *[Symbol.iterator](): Generator<Row> {
    for (const row of this.db.prepare("SELECT data FROM entries ORDER BY seq").iterate())
      yield JSON.parse(String(row.data));
  }
  at(index: number): Row | undefined {
    if (index < 0) index += this.length;
    const row = this.db.prepare("SELECT data FROM entries WHERE seq=?").get(index + 1);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } finally {
      rmSync(this.directory, { recursive: true, force: true });
    }
  }
}
export class LegacyState implements Iterable<[string, Row]> {
  private db: DatabaseSync;
  constructor(db: DatabaseSync) {
    this.db = db;
  }
  get(key: string): Row | undefined {
    const row = this.db.prepare("SELECT data FROM current_state WHERE key=?").get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  *[Symbol.iterator](): Generator<[string, Row]> {
    for (const row of this.db.prepare("SELECT key,data FROM current_state ORDER BY key").iterate())
      yield [String(row.key), JSON.parse(String(row.data))];
  }
}
export function object(value: unknown): value is Row {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
export async function* lines(path: string): AsyncGenerator<{ value: unknown; line: number }> {
  // Buffer each record once, with a hard bound independent of total history size.
  const pieces: Buffer[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    line = 0;
  const append = (piece: Buffer) => {
    size += piece.length;
    if (size > 8 * 1024 * 1024) throw new Error(`oversize record at line ${line + 1}`);
    pieces.push(piece);
  };
  const parse = (tail: boolean) => {
    let text: string;
    try {
      text = decoder.decode(Buffer.concat(pieces, size));
    } catch {
      throw new Error(`invalid UTF-8 at line ${line + 1}`);
    }
    pieces.length = 0;
    size = 0;
    line++;
    try {
      return { value: JSON.parse(text) as unknown, line };
    } catch {
      throw new Error(
        tail ? `incomplete tail at line ${line}; explicit recovery required` : `invalid JSON at line ${line}`,
      );
    }
  };
  for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 })) {
    let start = 0;
    for (let end = chunk.indexOf(10, start); end >= 0; end = chunk.indexOf(10, start)) {
      append(chunk.subarray(start, end));
      yield parse(false);
      start = end + 1;
    }
    if (start < chunk.length) append(chunk.subarray(start));
  }
  if (size) yield parse(true);
}

const customFields: Record<string, string[]> = {
  "zpi.session_meta": ["projectId", "pinnedAt", "archivedAt", "draft"],
  "zpi.title": ["state"],
  "zpi.attention": ["unreadAt"],
  "zpi.environment": ["parentSessionId", "worktree", "newWorktree", "worktreeBaseRef"],
  "zpi.fork": ["parentSessionId", "runId"],
  "zpi.queue": ["items", "autoDrain", "pauseReason"],
};
const knownCustom = new Set([
  ...Object.keys(customFields),
  "zpi.selection",
  "zpi.configuration",
  "zpi.run",
  "zpi.agent_call",
  "zpi.context_boundary",
  "zpi.subagent_task",
  "zpi.streaming_tools",
  "zpi.compaction",
  "zpi.notice",
]);
export async function readLegacySession(path: string): Promise<LegacySession> {
  let header: Row | undefined,
    parent: unknown = null;
  let provider: unknown,
    modelId: unknown,
    reasoning: unknown = "off",
    lastThinkingLevel: unknown = "medium",
    lastTimestamp: string | undefined;
  const entries = new LegacyEntries();
  const db = entries.db;
  const insert = db.prepare("INSERT INTO entries(seq,id,data) VALUES (?,?,?)");
  const hasId = db.prepare("SELECT seq FROM entries WHERE id=?");
  const journalDelete = db.prepare("DELETE FROM journal_updates WHERE journal_id=?");
  const journalInsert = db.prepare("INSERT INTO journal_updates(journal_id,seq,data) VALUES (?,?,?)");
  const acceptedInsert = db.prepare("INSERT OR IGNORE INTO accepted_queue(id) VALUES (?)");
  const acceptedQueueIds = {
    has: (id: string) => Boolean(db.prepare("SELECT 1 FROM accepted_queue WHERE id=?").get(id)),
  };
  const state = new LegacyState(db);
  const saveState = db.prepare(
    "INSERT INTO current_state(key,data) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET data=excluded.data",
  );
  const counts: Record<string, number> = {};
  try {
    db.exec("BEGIN");
    for await (const { value, line } of lines(path)) {
      if (!object(value)) throw new Error(`invalid object at line ${line}`);
      if (!header) {
        if (
          value.type !== "session" ||
          value.version !== 1 ||
          value.format !== "zpi" ||
          typeof value.id !== "string" ||
          !/^[\w-]+$/.test(value.id) ||
          typeof value.cwd !== "string" ||
          typeof value.timestamp !== "string" ||
          !Number.isFinite(Date.parse(value.timestamp))
        )
          throw new Error("unsupported v1 header");
        header = value;
        continue;
      }
      if (
        typeof value.id !== "string" ||
        hasId.get(value.id) ||
        value.parentId !== parent ||
        typeof value.timestamp !== "string" ||
        !Number.isFinite(Date.parse(value.timestamp))
      )
        throw new Error(`invalid chain at line ${line}`);
      parent = value.id;
      lastTimestamp = value.timestamp;
      if (value.type === "model_change") {
        provider = value.provider;
        modelId = value.modelId;
      }
      if (value.type === "message" && object(value.message) && value.message.role === "assistant") {
        provider = value.message.provider;
        modelId = value.message.model;
      }
      if (value.type === "thinking_level_change") {
        reasoning = value.thinkingLevel;
        if (reasoning !== "off") lastThinkingLevel = reasoning;
      }
      if (
        ![
          "message",
          "compaction",
          "model_change",
          "thinking_level_change",
          "session_info",
          "custom",
        ].includes(String(value.type))
      )
        throw new Error(`unknown record type at line ${line}`);
      if (value.type === "custom") {
        const key = String(value.customType);
        if (!knownCustom.has(key) && !key.startsWith("zpi.background_task:"))
          throw new Error(`unknown custom semantic ${key} at line ${line}`);
        if (!object(value.data)) throw new Error(`invalid ${key} data at line ${line}`);
        if (
          key === "zpi.configuration" &&
          value.data.communicationStyle !== undefined &&
          typeof value.data.communicationStyle !== "boolean"
        )
          throw new Error("invalid communication style capability");
        const fields = customFields[key];
        if (fields && Object.keys(value.data).some((field) => !fields.includes(field)))
          throw new Error(`unknown ${key} field at line ${line}`);
        if (key !== "zpi.streaming_tools") saveState.run(key, JSON.stringify(value.data));
        if (key === "zpi.streaming_tools") {
          if (typeof value.data.id !== "string") throw new Error("invalid streaming journal ID");
          if (value.data.committed === true) journalDelete.run(value.data.id);
          else journalInsert.run(value.data.id, entries.length + 1, JSON.stringify(value.data));
        }
        if (key === "zpi.run" && value.data.phase === "start" && typeof value.data.queueItemId === "string")
          acceptedInsert.run(value.data.queueItemId);
        const kind = key.startsWith("zpi.background_task:") ? "zpi.background_task" : key;
        counts[kind] = (counts[kind] ?? 0) + 1;
      } else {
        counts[String(value.type)] = (counts[String(value.type)] ?? 0) + 1;
        if (value.type === "session_info") saveState.run("session_info", JSON.stringify(value));
      }
      if (value.type === "compaction") {
        if (typeof value.firstKeptEntryId !== "string" || !hasId.get(value.firstKeptEntryId))
          throw new Error("invalid compaction boundary");
      }
      insert.run(++entries.length, value.id, JSON.stringify(value));
    }
    if (!header) throw new Error("empty session");
    db.exec("COMMIT");
    return {
      header,
      entries,
      state,
      acceptedQueueIds,
      counts,
      historicalSelection: {
        selection: provider && modelId ? { provider, modelId, reasoning } : undefined,
        lastThinkingLevel,
      },
      lastTimestamp,
      close: () => entries.close(),
    };
  } catch (error) {
    entries.close();
    throw error;
  }
}
export function recoveredQueue(session: LegacySession): Row {
  const queue = session.state.get("zpi.queue") ?? { items: [] };
  if (!Array.isArray(queue.items)) throw new Error("invalid queue");
  const seen = new Set<string>();
  const items = queue.items
    .filter((item: unknown) => {
      if (!object(item) || typeof item.id !== "string" || seen.has(item.id))
        throw new Error("invalid or duplicate queue item");
      seen.add(item.id);
      return !session.acceptedQueueIds.has(item.id);
    })
    .map((item: Row) => ({ ...item, state: "queued" }));
  return {
    ...queue,
    items,
    autoDrain: false,
    ...(items.length ? { pauseReason: queue.pauseReason ?? "restart" } : {}),
  };
}
class LegacySystemSnapshot {
  private snapshot: SystemMessage = {
    role: "system",
    content: "",
    sections: {},
    toolsAdded: [],
    timestamp: 0,
  };
  observe(entry: Row): void {
    if (entry.type !== "message" || !object(entry.message) || entry.message.role !== "system") return;
    const message = entry.message as unknown as SystemMessage;
    const text =
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n");
    if (text) this.snapshot.content += `${text}\n\n`;
    Object.assign(this.snapshot.sections ?? {}, message.sections);
    this.snapshot.toolsAdded = getCurrentTools([this.snapshot, message]);
    if (Buffer.byteLength(JSON.stringify(this.snapshot), "utf8") > 8 * 1024 * 1024)
      throw new Error(
        "generated compaction system snapshot exceeds the v2 8 MiB record limit; explicit format recovery required",
      );
  }
  at(timestamp: number): SystemMessage {
    return { ...this.snapshot, sections: { ...this.snapshot.sections }, timestamp };
  }
}

/** Only missing legacy compaction snapshots materialize their required system context. */
export function systemSnapshot(entries: LegacyEntries, beforeId: string, timestamp: number): SystemMessage {
  const boundary = entries.db.prepare("SELECT seq FROM entries WHERE id=?").get(beforeId);
  if (!boundary) throw new Error("missing compaction identity");
  entries.db.exec(`CREATE INDEX IF NOT EXISTS legacy_system_records ON entries(seq)
    WHERE json_extract(data,'$.type')='message' AND json_extract(data,'$.message.role')='system'`);
  const system = new LegacySystemSnapshot();
  for (const row of entries.db
    .prepare(`SELECT data FROM entries WHERE seq < ?
    AND json_extract(data,'$.type')='message' AND json_extract(data,'$.message.role')='system' ORDER BY seq`)
    .iterate(boundary.seq))
    system.observe(JSON.parse(String(row.data)));
  return system.at(timestamp);
}
