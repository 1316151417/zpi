import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  truncateSync,
} from "node:fs";
import { isJsonObject } from "zpi-ai";
import {
  isSessionEntry,
  isSessionHeader,
  maxSessionEntryBytes,
  type SessionEntry,
  type SessionHeader,
} from "zpi-coding-agent";
import { atomicJson } from "./storage.ts";

interface Span {
  start: number;
  end: number;
}
export interface CallBoundary extends Span {
  runId: string;
  ordinal: number;
  complete: boolean;
  legacy?: boolean;
}
interface RunBoundary {
  start: Span;
  end?: Span;
  ordinal: number;
  auxiliary?: boolean;
}
interface IndexData {
  version: 4;
  size: number;
  modified: number;
  header: SessionHeader;
  parentId: string | null;
  calls: CallBoundary[];
  runs: Record<string, RunBoundary>;
  state: Record<string, SessionEntry>;
  fileChanges: Span[];
  cacheRead: number;
  cacheInput: number;
  diagnostic?: string;
}
/** Derived byte offsets only. JSONL remains authoritative and model restoration remains independent. */
export class HistoryIndex {
  data!: IndexData;
  readBytes = 0;
  private currentRun = "";
  private dirty = false;
  private ids = new Set<string>();
  readonly path: string;
  constructor(path: string) {
    this.path = path;
  }
  static fresh(path: string): HistoryIndex {
    const index = new HistoryIndex(path),
      stat = statSync(path);
    index.data = {
      version: 4,
      size: stat.size,
      modified: stat.mtimeMs,
      header: JSON.parse(readFileSync(path, "utf8")),
      parentId: null,
      calls: [],
      runs: {},
      state: {},
      fileChanges: [],
      cacheRead: 0,
      cacheInput: 0,
    };
    return index;
  }
  async load(): Promise<void> {
    const stat = statSync(this.path);
    try {
      const cached = JSON.parse(readFileSync(`${this.path}.index.json`, "utf8")) as IndexData;
      if (
        cached.version === 4 &&
        cached.size === stat.size &&
        cached.modified === stat.mtimeMs &&
        cached.header &&
        Array.isArray(cached.calls)
      ) {
        this.data = cached;
        this.currentRun = Object.keys(cached.runs).at(-1) ?? "";
        return;
      }
    } catch {
      /* Missing/stale derived index is rebuilt with a bounded streaming scan. */
    }
    this.data = {
      version: 4,
      size: 0,
      modified: 0,
      header: undefined as unknown as SessionHeader,
      parentId: null,
      calls: [],
      runs: {},
      state: {},
      fileChanges: [],
      cacheRead: 0,
      cacheInput: 0,
    };
    let pending = Buffer.alloc(0),
      position = 0;
    for await (const chunk of createReadStream(this.path, { highWaterMark: 64 * 1024 })) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      this.readBytes += bytes.length;
      pending = Buffer.concat([pending, bytes]);
      let newline = pending.indexOf(10);
      while (newline >= 0) {
        const line = pending.subarray(0, newline);
        this.consume(line, position, position + newline + 1);
        position += newline + 1;
        pending = pending.subarray(newline + 1);
        newline = pending.indexOf(10);
      }
      if (pending.length > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
    }
    if (pending.length) {
      try {
        JSON.parse(pending.toString("utf8"));
        this.consume(pending, position, stat.size + 1);
        appendFileSync(this.path, "\n");
      } catch (error) {
        if (!position || !this.data.header) throw error;
        copyFileSync(this.path, `${this.path}.corrupt-${Date.now()}-${randomUUID()}`);
        truncateSync(this.path, position);
      }
    }
    if (this.data.header?.format !== "zpi") throw new Error("Unsupported session header");
    const finalStat = statSync(this.path);
    this.data.size = finalStat.size;
    this.data.modified = finalStat.mtimeMs;
    this.dirty = true;
    this.flush();
    this.ids.clear();
  }
  private consume(bytes: Buffer, start: number, end: number): void {
    try {
      if (bytes.length > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
      const row = JSON.parse(bytes.toString("utf8"));
      if (row.type === "session") {
        if (start !== 0 || !isSessionHeader(row)) throw new Error("Unsupported session header");
        this.data.header = row;
        return;
      }
      if (!isSessionEntry(row) || this.ids.has(row.id) || row.parentId !== this.data.parentId)
        throw new Error("Invalid session entry chain/content");
      this.ids.add(row.id);
      this.ingest(row, start, end);
    } catch (error) {
      this.data.diagnostic = `storage: Invalid JSONL record at byte ${start}: ${String(error)}`;
    }
  }
  ingest(
    entry: SessionEntry,
    start = this.data.size,
    end = start + Buffer.byteLength(JSON.stringify(entry)) + 1,
  ): void {
    const d = this.data;
    if (
      entry.type === "message" &&
      entry.message.role === "toolResult" &&
      isJsonObject(entry.message.details) &&
      isJsonObject(entry.message.details.fileChange)
    )
      d.fileChanges.push({ start, end });
    d.parentId = entry.id;
    d.size = end;
    this.dirty = true;
    if (entry.type === "thinking_level_change" && entry.thinkingLevel !== "off")
      d.state.thinking_last = entry;
    if (entry.type !== "message") {
      const key = entry.type === "custom" ? entry.customType : entry.type;
      if (
        [
          "model_change",
          "thinking_level_change",
          "session_info",
          "zpi.configuration",
          "zpi.session_meta",
          "zpi.title",
          "zpi.queue",
          "zpi.selection",
          "zpi.attention",
          "zpi.fork",
        ].includes(key)
      )
        d.state[key] = entry;
      if (entry.type === "model_change" || entry.type === "compaction") {
        d.cacheRead = 0;
        d.cacheInput = 0;
        delete d.state.usage;
      }
    } else if (entry.message.role === "assistant") {
      const m = entry.message;
      if (!["error", "aborted"].includes(m.stopReason) && m.usageAvailable !== false) {
        d.state.usage = { ...entry, message: { ...m, content: [] } };
        if (m.cacheUsageAvailable === true) {
          d.cacheRead += m.usage.cacheRead;
          d.cacheInput += m.usage.input + m.usage.cacheRead;
        }
      }
    }
    if (entry.type === "custom" && isJsonObject(entry.data)) {
      const value = entry.data;
      if (entry.customType === "zpi.run" && typeof value.runId === "string") {
        d.state["zpi.run"] = {
          ...entry,
          data: {
            phase: value.phase ?? null,
            runId: value.runId,
            status: value.status ?? null,
            startedAt: value.startedAt ?? null,
            endedAt: value.endedAt ?? null,
            queueItemId:
              value.queueItemId ??
              (value.phase === "end" &&
              d.state["zpi.run"]?.type === "custom" &&
              isJsonObject(d.state["zpi.run"].data)
                ? (d.state["zpi.run"].data.queueItemId ?? null)
                : null),
          },
        };
        this.currentRun = value.runId;
        if (value.phase === "start") {
          d.runs[this.currentRun] = {
            start: { start, end },
            ordinal: 0,
            auxiliary: value.agentBoundaries === true || value.local === true,
          };
          // Logs predating explicit Agent boundaries remain readable as legacy run groups.
          if (value.agentBoundaries !== true && value.local !== true)
            d.calls.push({
              start: end,
              end,
              runId: this.currentRun,
              ordinal: 0,
              complete: false,
              legacy: true,
            });
        } else if (value.phase === "end" && d.runs[this.currentRun]) {
          if (
            d.runs[this.currentRun].ordinal === 0 &&
            d.calls.at(-1)?.legacy &&
            d.calls.at(-1)?.runId === this.currentRun
          ) {
            d.calls.pop();
            d.runs[this.currentRun].auxiliary = true;
          }
          d.runs[this.currentRun].end = { start, end };
          const call = d.calls.at(-1);
          if (call?.legacy && call.runId === this.currentRun) {
            call.end = start;
            call.complete = true;
          }
        }
      }
      if (entry.customType === "zpi.agent_call" && d.runs[this.currentRun]) {
        const run = d.runs[this.currentRun],
          last = d.calls.at(-1);
        if (value.phase === "start") {
          run.auxiliary = false;
          if (typeof value.ordinal === "number") run.ordinal = value.ordinal;
          if (last?.legacy && last.runId === this.currentRun && last.ordinal === 0) d.calls.pop();
          d.calls.push({ start, end, runId: this.currentRun, ordinal: run.ordinal, complete: false });
        } else if (value.phase === "end" && last && last.runId === this.currentRun) {
          last.end = end;
          last.complete = true;
        }
      }
    }
    const run = d.runs[this.currentRun];
    const previousCall = d.calls.at(-1);
    if (
      entry.type === "message" &&
      entry.message.role === "user" &&
      run &&
      previousCall?.legacy &&
      previousCall.complete &&
      previousCall.runId === this.currentRun
    )
      d.calls.push({
        start,
        end,
        runId: this.currentRun,
        ordinal: run.ordinal,
        complete: false,
        legacy: true,
      });
    if (entry.type === "message" && entry.message.role !== "system" && run) run.ordinal++;
    const last = d.calls.at(-1);
    if (last && !last.complete) last.end = end;
    if (
      last?.legacy &&
      entry.type === "message" &&
      entry.message.role === "assistant" &&
      entry.message.stopReason !== "toolUse"
    )
      last.complete = true;
  }
  append(
    fields:
      | { type: "custom"; customType: string; data: import("zpi-ai").JsonValue }
      | { type: "session_info"; name: string }
      | { type: "model_change"; provider: string; modelId: string }
      | { type: "thinking_level_change"; thinkingLevel: import("zpi-agent").ThinkingLevel },
  ): void {
    const entry = {
      ...fields,
      id: randomUUID(),
      parentId: this.data.parentId,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    appendFileSync(this.path, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.ingest(entry);
    this.flush();
  }
  read(span: Span): SessionEntry[] {
    const length = span.end - span.start;
    if (length <= 0) return [];
    const fd = openSync(this.path, "r"),
      buffer = Buffer.alloc(length);
    try {
      let used = 0;
      while (used < length) {
        const n = readSync(fd, buffer, used, length - used, span.start + used);
        if (!n) throw new Error("storage: Truncated history segment");
        used += n;
      }
      this.readBytes += used;
      return buffer
        .toString("utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as SessionEntry);
    } finally {
      closeSync(fd);
    }
  }
  page(
    before = this.data.calls.length,
    count = 10,
  ): { entries: SessionEntry[]; cursor: number | null; calls: number } {
    if (!Number.isSafeInteger(before) || before < 0 || before > this.data.calls.length)
      throw new Error("invalid_input: 历史游标无效");
    const extra = before === this.data.calls.length && this.data.calls.at(-1)?.complete === false ? 1 : 0;
    const start = Math.max(0, before - count - extra),
      chunks: { start: number; entries: SessionEntry[] }[] = [];
    const anchors = new Map<string, { start: SessionEntry | undefined; end: SessionEntry[] }>();
    for (const call of this.data.calls.slice(start, before)) {
      const run = this.data.runs[call.runId];
      let cached = anchors.get(call.runId);
      if (!cached) {
        cached = { start: this.read(run.start)[0], end: run.end ? this.read(run.end) : [] };
        anchors.set(call.runId, cached);
      }
      const anchor = cached.start,
        entries: SessionEntry[] = [];
      if (anchor?.type === "custom" && isJsonObject(anchor.data)) {
        entries.push({ ...anchor, data: { ...anchor.data, ordinalStart: call.ordinal } });
      }
      entries.push(...this.read(call));
      entries.push(...cached.end);
      chunks.push({ start: call.start, entries });
    }
    const earliest = this.data.calls[start]?.start ?? 0;
    const latest = this.data.calls[before]?.start ?? this.data.size;
    for (const run of Object.values(this.data.runs))
      if (run.auxiliary && run.start.start >= earliest && run.start.start < latest)
        chunks.push({
          start: run.start.start,
          entries: this.read({ start: run.start.start, end: run.end?.end ?? this.data.size }),
        });
    return {
      entries: chunks.sort((a, b) => a.start - b.start).flatMap((chunk) => chunk.entries),
      cursor: start > 0 ? start : null,
      calls: before - start,
    };
  }
  flush(): void {
    if (!this.dirty || !existsSync(this.path)) return;
    this.data.modified = statSync(this.path).mtimeMs;
    atomicJson(`${this.path}.index.json`, this.data);
    this.dirty = false;
  }
}
