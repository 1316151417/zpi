import { randomUUID } from "node:crypto";
import { closeSync, createReadStream, fsyncSync, openSync, readSync, statSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { contentText, isJsonObject } from "zpi-ai";
import { maxSessionEntryBytes, type SessionEntry, type SessionHeader } from "zpi-coding-agent";
import type {
  IndexedSessionEntry,
  TranscriptContextPlan,
  TranscriptSnapshot,
  TranscriptState,
  TranscriptStore,
} from "../../../coding-agent/src/core/transcript-store.ts";
import { entryFileChange } from "./file-changes.ts";
import { syncDirectory } from "./storage-generation.ts";
import { deleteTranscriptIndex, ensureTranscriptSchema, transcriptPathKey } from "./transcript-schema.ts";
import {
  decodeTranscriptEntry,
  encodeTranscriptEntry,
  type TranscriptHeader,
  validateTranscriptEntry,
  validateTranscriptHeader,
} from "./transcript-v2.ts";

export interface Span {
  start: number;
  end: number;
}
export interface GenerationHooks {
  prepare(oldPath: string, newPath: string, header: SessionHeader): void;
  commit(oldPath: string, newPath: string, header: SessionHeader, watermark: number): void;
}
export interface RunBoundary {
  start: Span;
  end?: Span;
  ordinal: number;
  auxiliary?: boolean;
  runId: string;
}
interface IndexData {
  header: TranscriptHeader;
  parentId: string | null;
  size: number;
  modified: number;
  cacheRead: number;
  cacheInput: number;
  lastActivityAt?: number;
  diagnostic?: string;
}
type Row = Record<string, string | number | null>;
const initialState = (): TranscriptState => ({
  model: null,
  thinkingLevel: "off",
  lastThinkingLevel: "medium",
  hasThinkingEntry: false,
  lastMessageSeq: 0,
  lastCompactionSeq: 0,
});

/** JSONL is authoritative. SQLite stores normalized offsets and small derived projections only. */
export class HistoryIndex implements TranscriptStore {
  data!: IndexData;
  readBytes = 0;
  private seq = 0;
  private currentRun = "";
  private searchChars = 0;
  private writeError?: unknown;
  private state = initialState();
  path: string;
  readonly db: DatabaseSync;
  key: string;
  private generationHooks?: GenerationHooks;
  private missingDerivedTables = false;
  private batchStatements?: Map<string, StatementSync>;
  constructor(path: string, db: DatabaseSync, generationHooks?: GenerationHooks) {
    this.generationHooks = generationHooks;
    this.path = path;
    this.db = db;
    this.key = transcriptPathKey(db, path);
    this.missingDerivedTables = ensureTranscriptSchema(db);
  }
  private prepare(sql: string): StatementSync {
    if (!this.batchStatements) return this.db.prepare(sql);
    let statement = this.batchStatements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.batchStatements.set(sql, statement);
    }
    return statement;
  }
  private all(sql: string, ...args: SQLInputValue[]): Row[] {
    return this.prepare(sql).all(this.key, ...args) as Row[];
  }
  private one(sql: string, ...args: SQLInputValue[]): Row | undefined {
    return this.prepare(sql).get(this.key, ...args) as Row | undefined;
  }
  private run(sql: string, ...args: SQLInputValue[]): void {
    this.prepare(sql).run(this.key, ...args);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT transcript_write");
    try {
      const result = fn();
      this.db.exec("RELEASE transcript_write");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK TO transcript_write; RELEASE transcript_write");
      throw error;
    }
  }
  static create(
    path: string,
    db: DatabaseSync,
    header: SessionHeader,
    generationHooks?: GenerationHooks,
  ): HistoryIndex {
    const value = validateTranscriptHeader({ ...header, version: 2, generation: randomUUID() });
    const fd = openSync(path, "wx", 0o600);
    try {
      writeSync(fd, `${JSON.stringify(value)}\n`);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    syncDirectory(dirname(path));
    const index = HistoryIndex.fresh(path, db);
    index.generationHooks = generationHooks;
    return index;
  }
  static fresh(path: string, db: DatabaseSync): HistoryIndex {
    const index = new HistoryIndex(path, db);
    const stat = statSync(path);
    if (stat.size > maxSessionEntryBytes) throw new Error("storage: fresh requires a header-only file");
    const line = index.readBytesAt(0, stat.size).toString("utf8");
    if (!line.endsWith("\n") || line.trim().includes("\n"))
      throw new Error("storage: fresh requires a header-only file");
    index.reset(validateTranscriptHeader(JSON.parse(line)), stat.size);
    index.flush();
    index.missingDerivedTables = false;
    return index;
  }
  private reset(header: TranscriptHeader, size = 0): void {
    this.transaction(() => {
      deleteTranscriptIndex(this.db, this.key);
    });
    this.seq = 0;
    this.currentRun = "";
    this.searchChars = 0;
    this.state = initialState();
    this.data = { header, parentId: null, size, modified: 0, cacheRead: 0, cacheInput: 0 };
  }
  async load(): Promise<void> {
    const stat = statSync(this.path);
    const cached = this.one("SELECT * FROM transcript_state WHERE path=?");
    const indexedTail = this.one(
      "SELECT seq,entry_id,offset,length FROM transcript_entries WHERE path=? ORDER BY seq DESC LIMIT 1",
    );
    if (
      cached &&
      !this.missingDerivedTables &&
      Number(cached.seq) === Number(indexedTail?.seq ?? 0) &&
      (cached.parent_id ?? null) === (indexedTail?.entry_id ?? null) &&
      Number.isSafeInteger(cached.size) &&
      Number(cached.size) > 0 &&
      Number(cached.size) <= stat.size &&
      (!indexedTail || Number(indexedTail.offset) + Number(indexedTail.length) === Number(cached.size)) &&
      cached.inode === `${stat.dev}:${stat.ino}` &&
      (Number(cached.size) < stat.size || Number(cached.modified) === stat.mtimeMs)
    ) {
      try {
        this.data = {
          header: validateTranscriptHeader(JSON.parse(String(cached.header))),
          parentId: cached.parent_id as string | null,
          size: Number(cached.size),
          modified: Number(cached.modified),
          cacheRead: Number(cached.cache_read),
          cacheInput: Number(cached.cache_input),
          lastActivityAt: cached.activity === null ? undefined : Number(cached.activity),
        };
        this.seq = Number(cached.seq);
        this.currentRun = String(cached.current_run);
        this.state = this.getStateAt(this.snapshot());
        this.getState();
        this.searchChars = Number(
          this.one("SELECT COALESCE(SUM(length(text)),0) AS n FROM transcript_search WHERE path=?")?.n ?? 0,
        );
        // A small tail check detects truncation/replacement at the published boundary.
        if (this.data.size && this.readBytesAt(this.data.size - 1, 1)[0] !== 10)
          throw new Error("storage: Indexed boundary mismatch");
        if (this.data.size === stat.size) return;
      } catch {
        // Malformed derived rows never justify changing or discarding JSONL authority.
        this.reset(undefined as unknown as TranscriptHeader);
      }
    } else {
      this.reset(undefined as unknown as TranscriptHeader);
    }
    let position = this.data.size;
    const pieces: Buffer[] = [];
    let pendingSize = 0;
    for await (const chunk of createReadStream(this.path, { start: position, highWaterMark: 64 * 1024 })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.readBytes += bytes.length;
      const previousPosition = position;
      this.transaction(() => {
        let start = 0;
        for (;;) {
          const newline = bytes.indexOf(10, start);
          if (newline < 0) break;
          const part = bytes.subarray(start, newline);
          const length = pendingSize + part.length;
          const record = pieces.length ? Buffer.concat([...pieces, part], length) : part;
          this.consume(record, position, position + length + 1);
          position += length + 1;
          pieces.length = 0;
          pendingSize = 0;
          start = newline + 1;
        }
        if (start < bytes.length) {
          pieces.push(bytes.subarray(start));
          pendingSize += bytes.length - start;
        }
        if (pendingSize > maxSessionEntryBytes) throw new Error("storage: Entry exceeds 8 MiB");
        if (position !== previousPosition && this.data.header) this.flush();
      });
    }
    if (pendingSize) {
      const pending = Buffer.concat(pieces, pendingSize);
      // A complete valid final record may have lost only its newline. Validate and
      // index it transactionally before repairing that delimiter; malformed bytes
      // are preserved for explicit repair, never truncated or silently skipped.
      try {
        JSON.parse(pending.toString("utf8"));
      } catch {
        throw new Error(
          `storage: Unterminated transcript record at byte ${position}; recovery requires explicit repair`,
        );
      }
      this.transaction(() => {
        this.consume(pending, position, position + pending.length + 1);
        const fd = openSync(this.path, "a");
        try {
          writeSync(fd, "\n");
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        this.flush();
      });
    }
    if (!this.data.header) throw new Error("storage: Missing transcript header");
    this.flush();
    this.missingDerivedTables = false;
  }
  private consume(bytes: Buffer, start: number, end: number): void {
    if (bytes.length > maxSessionEntryBytes) throw new Error("storage: Entry exceeds 8 MiB");
    let row: unknown;
    try {
      row = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error(`storage: Invalid JSONL at byte ${start}`);
    }
    if (start === 0) {
      this.data.header = validateTranscriptHeader(row);
      this.data.size = end;
      return;
    }
    const entry = decodeTranscriptEntry(row);
    if (!isJsonObject(row) || row.seq !== this.seq + 1 || entry.parentId !== this.data.parentId)
      throw new Error(`storage: Invalid transcript sequence/chain at byte ${start}`);
    this.ingest(entry, start, end);
  }
  ingest(
    entry: SessionEntry,
    start = this.data.size,
    end = start + Buffer.byteLength(JSON.stringify(encodeTranscriptEntry(entry, this.seq + 1))) + 1,
  ): void {
    validateTranscriptEntry(entry);
    if (entry.parentId !== this.data.parentId) throw new Error("storage: Invalid append parent");
    const seq = this.seq + 1;
    const kept =
      entry.type === "compaction"
        ? this.one("SELECT seq FROM transcript_entries WHERE path=? AND entry_id=?", entry.firstKeptEntryId)
        : undefined;
    if (entry.type === "compaction" && !kept)
      throw new Error("storage: Missing compaction retained boundary");
    this.run(
      "INSERT INTO transcript_entries VALUES(?,?,?,?,?,?,?,?,?,?)",
      seq,
      entry.id,
      entry.type,
      entry.type === "message" ? entry.message.role : null,
      start,
      end - start,
      this.currentRun || null,
      entryFileChange(entry) ? 1 : 0,
      kept ? Number(kept.seq) : null,
    );
    this.seq = seq;
    this.data.parentId = entry.id;
    this.data.size = end;
    if (entry.type === "compaction") {
      this.state.lastCompactionSeq = seq;
      this.data.cacheRead = this.data.cacheInput = 0;
      this.run("DELETE FROM transcript_projections WHERE path=? AND key='usage'");
    }
    if (entry.type === "message") {
      this.state.lastMessageSeq = seq;
      const m = entry.message;
      if (
        m.role === "assistant" &&
        !["error", "aborted"].includes(m.stopReason) &&
        m.usageAvailable !== false &&
        (m.usageAvailable === true || m.usage.totalTokens > 0)
      ) {
        this.project("usage", seq, { ...entry, message: { ...m, content: [] } });
        if (m.cacheUsageAvailable === true) {
          this.data.cacheRead += m.usage.cacheRead;
          this.data.cacheInput += m.usage.input + m.usage.cacheRead + m.usage.cacheWrite;
        }
      }
    }
    if (entry.type === "compaction" || seq % 64 === 0)
      this.run("INSERT INTO transcript_checkpoints VALUES(?,?,?)", seq, JSON.stringify(this.state));
    if (entry.type === "custom" && isJsonObject(entry.data)) {
      const value = entry.data;
      if (entry.customType === "zpi.run")
        this.project(entry.customType, seq, {
          ...entry,
          data: {
            phase: value.phase ?? null,
            runId: value.runId ?? null,
            status: value.status ?? null,
            startedAt: value.startedAt ?? null,
            endedAt: value.endedAt ?? null,
            queueItemId: value.queueItemId ?? null,
          },
        });
      if (entry.customType === "zpi.run" && typeof value.runId === "string") {
        this.currentRun = value.runId;
        if (value.phase === "start") {
          this.run(
            "INSERT INTO transcript_anchors VALUES(?,?,?)",
            start,
            JSON.stringify({
              ...entry,
              data: {
                phase: "start",
                runId: value.runId,
                historyContinuation: true,
                startedAt: value.startedAt,
                ordinalStart: value.ordinalStart,
                modelLabel: typeof value.modelLabel === "string" ? value.modelLabel.slice(0, 512) : "",
              },
            }),
          );
          if (
            isJsonObject(value.modelConfig) &&
            typeof value.modelConfig.provider === "string" &&
            typeof value.modelConfig.modelId === "string"
          )
            this.state.model = { provider: value.modelConfig.provider, modelId: value.modelConfig.modelId };
          const level = value.thinkingLevel;
          if (
            level === "off" ||
            level === "minimal" ||
            level === "low" ||
            level === "medium" ||
            level === "high" ||
            level === "xhigh"
          ) {
            this.state.thinkingLevel = level;
            this.state.hasThinkingEntry = true;
            if (level !== "off") this.state.lastThinkingLevel = level;
          }
          this.run(
            "INSERT OR REPLACE INTO transcript_checkpoints VALUES(?,?,?)",
            seq,
            JSON.stringify(this.state),
          );
        }
        if (value.phase === "start")
          this.run(
            "INSERT INTO transcript_runs VALUES(?,?,?,?,?,?,?,?,?,?,?)",
            value.runId,
            start,
            end,
            null,
            null,
            typeof value.ordinal === "number" ? value.ordinal : 0,
            value.local === true ? 1 : 0,
            null,
            null,
            typeof value.queueItemId === "string" ? value.queueItemId : null,
          );
        else if (value.phase === "accepted")
          this.prepare(
            "UPDATE transcript_runs SET accepted_seq=?,accepted_end=? WHERE path=? AND run_id=?",
          ).run(seq, end, this.key, value.runId);
        else if (value.phase === "end")
          this.prepare("UPDATE transcript_runs SET end=?,end_end=? WHERE path=? AND run_id=?").run(
            start,
            end,
            this.key,
            value.runId,
          );
      }
      if (
        (entry.customType === "zpi.context_boundary" || entry.customType === "zpi.run") &&
        isJsonObject(value.historyConfiguration)
      ) {
        const config = value.historyConfiguration;
        const model = config.model;
        if (
          model === null ||
          (isJsonObject(model) && typeof model.provider === "string" && typeof model.modelId === "string")
        )
          this.state.model = model as TranscriptState["model"];
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh"];
        if (typeof config.thinkingLevel === "string" && levels.includes(config.thinkingLevel))
          this.state.thinkingLevel = config.thinkingLevel as TranscriptState["thinkingLevel"];
        if (typeof config.lastThinkingLevel === "string" && levels.includes(config.lastThinkingLevel))
          this.state.lastThinkingLevel = config.lastThinkingLevel as TranscriptState["lastThinkingLevel"];
        if (typeof config.hasThinkingEntry === "boolean")
          this.state.hasThinkingEntry = config.hasThinkingEntry;
        this.run(
          "INSERT OR REPLACE INTO transcript_checkpoints VALUES(?,?,?)",
          seq,
          JSON.stringify(this.state),
        );
      }
      if (entry.customType === "zpi.agent_call") {
        if (value.phase === "start")
          this.run(
            "INSERT INTO transcript_calls VALUES(?,?,?,?,?,?,?)",
            seq,
            this.currentRun,
            typeof value.ordinal === "number" ? value.ordinal : 0,
            start,
            end,
            0,
          );
        else if (value.phase === "end")
          this.prepare(
            "UPDATE transcript_calls SET end=?,complete=1 WHERE path=? AND seq=(SELECT MAX(seq) FROM transcript_calls WHERE path=? AND run_id=?)",
          ).run(end, this.key, this.key, this.currentRun);
      }
      if (entry.customType === "zpi.streaming_tools" && typeof value.id === "string") {
        if (value.committed === true)
          this.run("DELETE FROM transcript_pending_journals WHERE path=? AND journal_id=?", value.id);
        else
          this.run(
            "INSERT INTO transcript_pending_journals VALUES(?,?,?,?) ON CONFLICT(path,journal_id) DO NOTHING",
            value.id,
            seq,
            typeof value.anchorId === "string" ? value.anchorId : null,
          );
        this.run(
          "INSERT INTO transcript_journals VALUES(?,?,?,?,?)",
          value.id,
          seq,
          typeof value.anchorId === "string" ? value.anchorId : null,
          value.committed === true ? 1 : 0,
        );
      }
    }
    this.prepare("UPDATE transcript_calls SET end=? WHERE path=? AND complete=0").run(end, this.key);
    if (entry.type === "message" || (entry.type === "custom" && entry.customType === "zpi.run")) {
      const at = Date.parse(entry.timestamp);
      if (Number.isFinite(at)) this.data.lastActivityAt = Math.max(this.data.lastActivityAt ?? 0, at);
    }
    let text = "";
    if (
      entry.type === "custom" &&
      entry.customType === "zpi.run" &&
      isJsonObject(entry.data) &&
      entry.data.phase === "start" &&
      typeof entry.data.text === "string"
    )
      text = entry.data.text;
    if (entry.type === "message" && entry.message.role === "assistant")
      text = contentText(entry.message.content);
    if (text) {
      const bounded = text.slice(0, Math.max(0, 200000 - this.searchChars));
      if (bounded) {
        this.run("INSERT INTO transcript_search VALUES(?,?,?,?)", seq, this.currentRun, bounded);
        this.searchChars += bounded.length;
      }
    }
  }
  private project(key: string, seq: number, entry: SessionEntry): void {
    this.run(
      "INSERT INTO transcript_projections VALUES(?,?,?,?) ON CONFLICT(path,key) DO UPDATE SET seq=excluded.seq,value=excluded.value",
      key,
      seq,
      JSON.stringify(entry),
    );
  }
  append(entry: SessionEntry): void {
    if (this.writeError)
      throw new Error("storage: Previous index write failed; reopen before writing", {
        cause: this.writeError,
      });
    validateTranscriptEntry(entry);
    if (entry.parentId !== this.data.parentId) throw new Error("storage: Invalid append parent");
    if (this.one("SELECT seq FROM transcript_entries WHERE path=? AND entry_id=?", entry.id))
      throw new Error("storage: Duplicate entry ID");
    if (entry.type === "compaction" && !this.readEntryById(entry.firstKeptEntryId, this.snapshot()))
      throw new Error("storage: Missing compaction retained boundary");
    if (statSync(this.path).size !== this.data.size)
      throw new Error("storage: Unindexed transcript tail; reopen before writing");
    const line = Buffer.from(`${JSON.stringify(encodeTranscriptEntry(entry, this.seq + 1))}\n`);
    if (line.length - 1 > maxSessionEntryBytes) throw new Error("storage: Entry exceeds 8 MiB");
    const fd = openSync(this.path, "a");
    try {
      let offset = 0;
      while (offset < line.length) offset += writeSync(fd, line, offset);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      this.transaction(() => {
        this.ingest(entry, this.data.size, this.data.size + line.length);
        this.flush();
      });
    } catch (error) {
      this.writeError = error;
      throw error;
    }
  }
  flush(): void {
    const stat = statSync(this.path);
    this.data.modified = stat.mtimeMs;
    this.run(
      "INSERT OR REPLACE INTO transcript_state VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      this.data.header.generation,
      JSON.stringify(this.data.header),
      this.data.size,
      stat.mtimeMs,
      `${stat.dev}:${stat.ino}`,
      this.seq,
      this.data.parentId,
      this.currentRun,
      this.data.cacheRead,
      this.data.cacheInput,
      this.data.lastActivityAt ?? null,
    );
  }
  getHeader(): SessionHeader {
    return this.data.header;
  }
  getFile(): string {
    return this.path;
  }
  snapshot(): TranscriptSnapshot {
    return { generation: this.data.header.generation, endSeq: this.seq };
  }
  private check(snapshot: TranscriptSnapshot): void {
    if (
      snapshot.generation !== this.data.header.generation ||
      snapshot.endSeq > this.seq ||
      snapshot.endSeq < 0
    )
      throw new Error("storage: Stale transcript snapshot");
  }
  getStateAt(snapshot: TranscriptSnapshot): TranscriptState {
    this.check(snapshot);
    const row = this.one(
      "SELECT seq,state FROM transcript_checkpoints WHERE path=? AND seq<=? ORDER BY seq DESC LIMIT 1",
      snapshot.endSeq,
    );
    const state = row ? (JSON.parse(String(row.state)) as TranscriptState) : initialState();
    if (
      !state ||
      typeof state !== "object" ||
      !Number.isSafeInteger(state.lastCompactionSeq) ||
      state.lastCompactionSeq < 0 ||
      state.lastCompactionSeq > snapshot.endSeq ||
      typeof state.hasThinkingEntry !== "boolean"
    )
      throw new Error("storage: Invalid transcript checkpoint");
    const last = this.one(
      "SELECT MAX(seq) AS seq FROM transcript_entries WHERE path=? AND type='message' AND seq<=?",
      snapshot.endSeq,
    );
    state.lastMessageSeq = Number(last?.seq ?? 0);
    return state;
  }
  getTail(snapshot: TranscriptSnapshot): IndexedSessionEntry | undefined {
    this.check(snapshot);
    return this.entryAt(snapshot.endSeq);
  }
  private entryAt(seq: number): IndexedSessionEntry | undefined {
    const row = this.one("SELECT * FROM transcript_entries WHERE path=? AND seq=?", seq);
    return row ? this.readIndexedEntry(row) : undefined;
  }
  private readIndexedEntry(row: Row): IndexedSessionEntry {
    const seq = Number(row.seq);
    const value = JSON.parse(this.readBytesAt(Number(row.offset), Number(row.length)).toString("utf8"));
    const entry = decodeTranscriptEntry(value);
    if (value.seq !== seq || entry.id !== row.entry_id)
      throw new Error("storage: Transcript index boundary mismatch");
    return { seq, entry };
  }
  private requiredEntryAt(seq: number): SessionEntry {
    const indexed = this.entryAt(seq);
    if (!indexed) throw new Error("storage: Missing transcript index entry");
    return indexed.entry;
  }
  readEntryById(id: string, snapshot: TranscriptSnapshot): IndexedSessionEntry | undefined {
    this.check(snapshot);
    const row = this.one(
      "SELECT seq FROM transcript_entries WHERE path=? AND entry_id=? AND seq<=?",
      id,
      snapshot.endSeq,
    );
    return row ? this.entryAt(Number(row.seq)) : undefined;
  }
  *readRange(
    startSeq: number,
    endSeq: number,
    snapshot: TranscriptSnapshot,
    types?: readonly SessionEntry["type"][],
  ): Iterable<IndexedSessionEntry> {
    this.check(snapshot);
    if (types?.length === 0) return;
    let seq = startSeq;
    while (seq <= Math.min(endSeq, snapshot.endSeq)) {
      this.check(snapshot);
      const filter = types ? ` AND type IN (${types.map(() => "?").join(",")})` : "";
      const rows = this.all(
        `SELECT seq,entry_id,offset,length FROM transcript_entries WHERE path=? AND seq>=? AND seq<=?${filter} ORDER BY seq LIMIT 128`,
        seq,
        Math.min(endSeq, snapshot.endSeq),
        ...(types ?? []),
      );
      if (!rows.length) return;
      for (const row of rows) {
        yield this.readIndexedEntry(row);
        seq = Number(row.seq) + 1;
      }
    }
  }
  getContextPlan(snapshot: TranscriptSnapshot): TranscriptContextPlan {
    this.check(snapshot);
    const row = this.one(
      "SELECT seq,kept_seq FROM transcript_entries WHERE path=? AND type='compaction' AND seq<=? ORDER BY seq DESC LIMIT 1",
      snapshot.endSeq,
    );
    return {
      snapshot,
      firstKeptSeq: row ? Number(row.kept_seq) : 1,
      compaction: row ? this.entryAt(Number(row.seq)) : undefined,
    };
  }
  *readUnresolvedToolJournals(snapshot: TranscriptSnapshot): Iterable<SessionEntry[]> {
    this.check(snapshot);
    const groups =
      snapshot.endSeq === this.seq
        ? this.db
            .prepare("SELECT journal_id,first_seq,anchor_id FROM transcript_pending_journals WHERE path=?")
            .all(this.key)
        : this.db
            .prepare(
              "SELECT journal_id,MIN(seq) AS first_seq,MAX(anchor_id) AS anchor_id FROM transcript_journals WHERE path=? AND seq<=? GROUP BY journal_id HAVING MAX(committed)=0",
            )
            .all(this.key, snapshot.endSeq);
    for (const item of groups) {
      const row = item as Row;
      const entries: SessionEntry[] = [];
      const anchor = row.anchor_id ? this.readEntryById(String(row.anchor_id), snapshot) : undefined;
      if (anchor) entries.push(anchor.entry);
      const next = this.one(
        "SELECT MIN(seq) AS seq FROM transcript_entries WHERE path=? AND type='message' AND role='user' AND seq>?",
        Number(row.first_seq),
      );
      const end = Math.min(snapshot.endSeq, next?.seq ? Number(next.seq) - 1 : snapshot.endSeq);
      for (const indexed of this.readRange(Number(row.first_seq), end, snapshot)) {
        const e = indexed.entry;
        if (
          e.type === "message" ||
          (e.type === "custom" &&
            e.customType === "zpi.streaming_tools" &&
            isJsonObject(e.data) &&
            e.data.id === row.journal_id)
        )
          entries.push(e);
      }
      yield entries;
    }
  }
  private readBytesAt(start: number, length: number): Buffer {
    if (!Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(length) || length < 0)
      throw new Error("storage: Invalid transcript index span");
    if (length > maxSessionEntryBytes + 1) throw new Error("storage: Read exceeds record budget");
    const fd = openSync(this.path, "r");
    const bytes = Buffer.alloc(length);
    try {
      let offset = 0;
      while (offset < length) {
        const n = readSync(fd, bytes, offset, length - offset, start + offset);
        if (!n) throw new Error("storage: Truncated transcript");
        offset += n;
      }
      this.readBytes += length;
      return bytes;
    } finally {
      closeSync(fd);
    }
  }
  read(span: Span): SessionEntry[] {
    const rows = this.all(
      "SELECT seq FROM transcript_entries WHERE path=? AND offset>=? AND offset<? ORDER BY seq",
      span.start,
      span.end,
    );
    return rows.map((row) => this.requiredEntryAt(Number(row.seq)));
  }
  getState(): Record<string, SessionEntry> {
    const result: Record<string, SessionEntry> = {};
    for (const row of this.all("SELECT key,value FROM transcript_projections WHERE path=?"))
      result[String(row.key)] = JSON.parse(String(row.value)) as SessionEntry;
    return result;
  }
  searchTextFor(query: string, limit = 80): { runId: string; text: string }[] {
    return this.all(
      "SELECT run_id,text FROM transcript_search WHERE path=? AND instr(lower(text),lower(?))>0 ORDER BY seq LIMIT ?",
      query,
      Math.min(80, Math.max(1, limit)),
    ).map((row) => ({ runId: String(row.run_id), text: String(row.text) }));
  }
  hasSearchText(query: string): boolean {
    return Boolean(
      this.one(
        "SELECT 1 AS found FROM transcript_search WHERE path=? AND instr(lower(text),lower(?))>0 LIMIT 1",
        query,
      ),
    );
  }
  searchText(): { runId: string; text: string }[] {
    return this.all("SELECT run_id,text FROM transcript_search WHERE path=? ORDER BY seq").map((row) => ({
      runId: String(row.run_id),
      text: String(row.text),
    }));
  }
  countRuns(): number {
    return Number(this.one("SELECT COUNT(*) AS n FROM transcript_runs WHERE path=?")?.n ?? 0);
  }
  findRun(runId: string): RunBoundary | undefined {
    const row = this.one("SELECT * FROM transcript_runs WHERE path=? AND run_id=?", runId);
    return row ? runBoundary(row) : undefined;
  }
  *listRuns(): Iterable<RunBoundary> {
    for (const row of this.db
      .prepare("SELECT * FROM transcript_runs WHERE path=? ORDER BY start DESC")
      .iterate(this.key))
      yield runBoundary(row as Row);
  }
  *fileChanges(): Iterable<Span> {
    for (const row of this.db
      .prepare("SELECT offset,length FROM transcript_entries WHERE path=? AND file_change=1 ORDER BY seq")
      .iterate(this.key))
      yield { start: Number(row.offset), end: Number(row.offset) + Number(row.length) };
  }
  page(
    before = this.seq + 1,
    count = 10,
    after = 0,
  ): { entries: SessionEntry[]; cursor: number | null; calls: number } {
    if (before === 0) return { entries: [], cursor: null, calls: 0 };
    if (!Number.isSafeInteger(count) || count < 1 || count > 100)
      throw new Error("invalid_input: 历史页大小无效");
    if (!Number.isSafeInteger(before) || before < 1 || before > this.seq + 1)
      throw new Error("invalid_input: 历史游标无效");
    if (!Number.isSafeInteger(after) || after < 0 || after > this.seq)
      throw new Error("invalid_input: 历史边界无效");
    if (before <= after + 1) return { entries: [], cursor: null, calls: 0 };
    const selected: number[] = [];
    let bytes = 0;
    let calls = 0;
    const rows = this.db.prepare(
      "SELECT seq,length FROM transcript_entries WHERE path=? AND seq<? AND seq>? ORDER BY seq DESC",
    );
    for (const value of rows.iterate(this.key, before, after)) {
      const row = value as Row;
      if (selected.length && bytes + Number(row.length) > 2 * 1024 * 1024) break;
      selected.push(Number(row.seq));
      bytes += Number(row.length);
      if (this.one("SELECT seq FROM transcript_calls WHERE path=? AND seq=?", Number(row.seq))) {
        calls++;
        if (calls >= count) break;
      }
    }
    selected.reverse();
    const entries = selected.map((seq) => this.requiredEntryAt(seq));
    const first = selected[0] ?? before;
    // Prefix the enclosing run for UI grouping, without reading its complete body.
    const offset = this.one("SELECT offset FROM transcript_entries WHERE path=? AND seq=?", first)?.offset;
    if (offset !== undefined) {
      const run = this.one(
        "SELECT start,start_end FROM transcript_runs WHERE path=? AND start<=? ORDER BY start DESC LIMIT 1",
        offset,
      );
      if (run && Number(run.start) < Number(offset)) {
        // A continuation needs grouping, not another copy of a potentially 8 MiB input.
        const anchor = this.one(
          "SELECT value FROM transcript_anchors WHERE path=? AND offset=?",
          Number(run.start),
        );
        if (!anchor) throw new Error("storage: Missing run continuation index; rebuild the transcript index");
        const continuation = JSON.parse(String(anchor.value)) as SessionEntry;
        if (continuation.type !== "custom" || !isJsonObject(continuation.data))
          throw new Error("storage: Invalid run continuation index");
        const preceding = this.one(
          "SELECT COUNT(*) AS n FROM transcript_entries WHERE path=? AND type='message' AND role<>'system' AND offset>? AND offset<?",
          Number(run.start),
          Number(offset),
        );
        continuation.data.ordinalStart =
          Number(continuation.data.ordinalStart ?? 0) + Number(preceding?.n ?? 0);
        entries.unshift(continuation);
      }
    }
    return { entries, cursor: first > after + 1 ? first : null, calls };
  }
  seqAtOffset(offset: number): number | undefined {
    const row = this.one(
      "SELECT seq FROM transcript_entries WHERE path=? AND offset>=? ORDER BY seq LIMIT 1",
      offset,
    );
    return row ? Number(row.seq) : undefined;
  }
  *readReverse(snapshot: TranscriptSnapshot): Iterable<IndexedSessionEntry> {
    this.check(snapshot);
    let before = snapshot.endSeq + 1;
    while (before > 1) {
      const rows = this.all(
        "SELECT seq,entry_id,offset,length FROM transcript_entries WHERE path=? AND seq<? ORDER BY seq DESC LIMIT 128",
        before,
      );
      if (!rows.length) return;
      for (const row of rows) {
        this.check(snapshot);
        yield this.readIndexedEntry(row);
        before = Number(row.seq);
      }
    }
  }
  findAcceptedRun(runId: string): { watermark: number; queueItemId?: string } | undefined {
    const row = this.one(
      "SELECT accepted_end,queue_item_id FROM transcript_runs WHERE path=? AND run_id=? AND accepted_seq IS NOT NULL",
      runId,
    );
    return row
      ? {
          watermark: Number(row.accepted_end),
          queueItemId: row.queue_item_id === null ? undefined : String(row.queue_item_id),
        }
      : undefined;
  }
  /** Build an unpublished generation with bounded memory and one durability boundary. */
  private static stageGeneration(
    path: string,
    db: DatabaseSync,
    header: SessionHeader,
    entries: Iterable<SessionEntry>,
  ): HistoryIndex {
    const value = validateTranscriptHeader({ ...header, version: 2, generation: randomUUID() });
    const staged = new HistoryIndex(path, db);
    const fd = openSync(path, "wx", 0o600);
    const write = (line: Buffer) => {
      let offset = 0;
      while (offset < line.length) {
        const written = writeSync(fd, line, offset);
        if (written === 0) throw new Error("storage: Transcript write made no progress");
        offset += written;
      }
    };
    staged.batchStatements = new Map();
    try {
      staged.transaction(() => {
        const line = Buffer.from(`${JSON.stringify(value)}\n`);
        if (line.length > maxSessionEntryBytes) throw new Error("storage: Header exceeds 8 MiB");
        staged.reset(value, line.length);
        write(line);
        for (const entry of entries) {
          const line = Buffer.from(`${JSON.stringify(encodeTranscriptEntry(entry, staged.seq + 1))}\n`);
          if (line.length - 1 > maxSessionEntryBytes) throw new Error("storage: Entry exceeds 8 MiB");
          // ingest validates the chain, compaction boundary and unique IDs against this transaction.
          // A failed iteration leaves only an unpublished file; no partial index transaction survives.
          staged.ingest(entry, staged.data.size, staged.data.size + line.length);
          write(line);
        }
        fsyncSync(fd);
        staged.flush();
      });
    } finally {
      staged.batchStatements = undefined;
      closeSync(fd);
    }
    // Persist the new directory entry before the generation hooks can publish its locator.
    syncDirectory(dirname(path));
    return staged;
  }
  replace(header: SessionHeader, entries: Iterable<SessionEntry>): void {
    const nextPath = join(dirname(this.path), `${header.id}.generation-${randomUUID()}.jsonl`);
    this.generationHooks?.prepare(this.path, nextPath, header);
    const staged = HistoryIndex.stageGeneration(nextPath, this.db, header, entries);
    // Publication changes only the DB locator. The previous immutable generation survives every failure.
    this.generationHooks?.commit(this.path, nextPath, staged.getHeader(), staged.data.size);
    this.path = staged.path;
    this.key = staged.key;
    this.data = staged.data;
    this.seq = staged.seq;
    this.currentRun = staged.currentRun;
    this.state = staged.state;
    this.searchChars = staged.searchChars;
    this.writeError = undefined;
  }
}
function runBoundary(row: Row): RunBoundary {
  return {
    runId: String(row.run_id),
    start: { start: Number(row.start), end: Number(row.start_end) },
    end: row.end === null ? undefined : { start: Number(row.end), end: Number(row.end_end) },
    ordinal: Number(row.ordinal),
    auxiliary: row.auxiliary === 1,
  };
}
