import { createHash, randomUUID } from "node:crypto";
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ThinkingLevel } from "zpi-agent";
import type { JsonValue, Message, SystemMessage, Usage } from "zpi-ai";
import { assertSupportedOptions, getCurrentTools, isJsonObject } from "zpi-ai";
import { applyMicrocompactBoundary, microcompactClearedIds } from "./microcompact.ts";
import {
  isSessionEntry,
  isSessionHeader,
  maxSessionEntryBytes,
  validateMessage,
} from "./record-validation.ts";
import { recoverStreamedToolJournal } from "./streaming-tool-journal.ts";
import type {
  SessionCurrentState,
  TranscriptSnapshot,
  TranscriptState,
  TranscriptStore,
} from "./transcript-store.ts";
import { getMessageProvenance, setMessageProvenance } from "./transcript-store.ts";
export interface SessionHeader {
  type: "session";
  version: 1 | 2;
  format: "zpi";
  id: string;
  timestamp: string;
  cwd: string;
}
interface EntryBase {
  id: string;
  parentId: string | null;
  timestamp: string;
}
export type SessionEntry = EntryBase &
  (
    | { type: "message"; message: Message }
    | { type: "model_change"; provider: string; modelId: string }
    | { type: "thinking_level_change"; thinkingLevel: ThinkingLevel }
    | { type: "session_info"; name: string }
    | { type: "custom"; customType: string; data?: JsonValue }
    | { type: "microcompact"; data: import("./microcompact.ts").MicrocompactBoundary }
    | {
        type: "compaction";
        summary: string;
        firstKeptEntryId: string;
        tokensBefore?: number;
        details?: { readFiles: string[]; modifiedFiles: string[] };
        usage?: Usage;
        systemMessage?: SystemMessage;
      }
  );
export interface SessionContext {
  messages: Message[];
  thinkingLevel: ThinkingLevel;
  model: { provider: string; modelId: string } | null;
  lastThinkingLevel: ThinkingLevel;
}
export class SessionManager {
  private header: SessionHeader;
  private store?: TranscriptStore;
  private currentState?: SessionCurrentState;
  private contextCache?: { generation: string; endSeq: number; context: SessionContext };
  private entries: SessionEntry[] = [];
  private file?: string;
  private storageError?: Error;
  private appendListeners = new Set<(entry: SessionEntry) => void>();
  subscribeEntries(listener: (entry: SessionEntry) => void): () => void {
    this.appendListeners.add(listener);
    return () => {
      this.appendListeners.delete(listener);
    };
  }
  private constructor(cwd: string, id: string = randomUUID()) {
    this.header = {
      type: "session",
      version: 1,
      format: "zpi",
      id,
      timestamp: new Date().toISOString(),
      cwd: resolve(cwd),
    };
  }
  /** Open an already validated indexed store without reading historical message bodies. */
  static fromStore(store: TranscriptStore, currentState?: SessionCurrentState): SessionManager {
    const header = store.getHeader();
    const manager = new SessionManager(header.cwd, header.id);
    manager.header = header;
    manager.file = store.getFile();
    manager.store = store;
    manager.currentState = currentState;
    recoverStreamedToolJournal(manager);
    return manager;
  }
  static async openAsync(
    store: TranscriptStore,
    currentState?: SessionCurrentState,
  ): Promise<SessionManager> {
    return SessionManager.fromStore(store, currentState);
  }
  hasCurrentState(): boolean {
    return this.currentState !== undefined;
  }
  getCurrentState(): Pick<TranscriptState, "model" | "thinkingLevel" | "lastThinkingLevel" | "name"> {
    if (this.store && !this.currentState) throw new Error("Indexed session requires current-state reader");
    return this.currentState?.get() ?? this.getStateAt();
  }
  getStateAt(snapshot?: TranscriptSnapshot): TranscriptState {
    if (this.store) return this.store.getStateAt(snapshot ?? this.store.snapshot());
    const context = buildSessionContext(this.entries);
    return {
      model: context.model,
      thinkingLevel: context.thinkingLevel,
      lastThinkingLevel: context.lastThinkingLevel,
      hasThinkingEntry: this.entries.some((e) => e.type === "thinking_level_change"),
      lastMessageSeq: this.entries.findLastIndex((e) => e.type === "message") + 1,
      lastCompactionSeq: this.entries.findLastIndex((e) => e.type === "compaction") + 1,
      name: this.entries.findLast((e) => e.type === "session_info")?.name,
    };
  }
  *iterateEntries(): Iterable<SessionEntry> {
    if (!this.store) {
      yield* this.entries;
      return;
    }
    const snapshot = this.store.snapshot();
    for (const { entry } of this.store.readRange(1, snapshot.endSeq, snapshot)) yield entry;
  }
  readEntryById(id: string): SessionEntry | undefined {
    return this.store
      ? this.store.readEntryById(id, this.store.snapshot())?.entry
      : this.entries.find((e) => e.id === id);
  }
  *unresolvedToolJournals(): Iterable<SessionEntry[]> {
    if (this.store) yield* this.store.readUnresolvedToolJournals(this.store.snapshot());
    else yield this.entries;
  }
  /** Only effective retained entries, suitable for compaction and current usage. */
  getContextEntries(): SessionEntry[] {
    if (!this.store) return this.entries.slice();
    const snapshot = this.store.snapshot();
    const plan = this.store.getContextPlan(snapshot);
    const result: SessionEntry[] = [];
    for (const { entry } of this.store.readRange(plan.firstKeptSeq, snapshot.endSeq, snapshot, [
      "message",
      "compaction",
      "model_change",
    ]))
      result.push(entry);
    return result;
  }
  precedesCompaction(message: Message): boolean {
    const source = getMessageProvenance(message);
    return source !== undefined && source.seq < this.getStateAt().lastCompactionSeq;
  }
  async materializeContext(snapshot?: TranscriptSnapshot): Promise<SessionContext> {
    return this.buildSessionContext(snapshot);
  }
  static create(
    cwd: string,
    sessionDir = join(homedir(), ".zpi", "agent", "sessions"),
    options: { id?: string } = {},
  ): SessionManager {
    assertSupportedOptions(options, ["id"], "SessionManager.create");
    const manager = new SessionManager(cwd, options.id);
    if (!/^[a-zA-Z0-9_-]+$/.test(manager.header.id)) throw new Error("Invalid session id");
    manager.file = join(sessionDir, `${manager.header.id}.jsonl`);
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(manager.file, `${JSON.stringify(manager.header)}\n`, { flag: "wx", mode: 0o600 });
    return manager;
  }
  static inMemory(
    cwd = process.cwd(),
    options: { id?: string } = {},
    entries: SessionEntry[] = [],
  ): SessionManager {
    assertSupportedOptions(options, ["id"], "SessionManager.inMemory");
    const m = new SessionManager(cwd, options.id);
    if (entries.some((e) => !isSessionEntry(e))) throw new Error("Invalid in-memory session entries");
    m.entries = structuredClone(entries);
    return m;
  }
  static open(path: string, _sessionDir?: string, cwdOverride?: string): SessionManager {
    const raw = readFileSync(path, "utf8");
    const lines = raw.split("\n");
    if (lines.at(-1) === "") lines.pop();
    const parsed: unknown[] = [];
    let repairTo: string | undefined;
    for (let i = 0; i < lines.length; i++) {
      try {
        if (Buffer.byteLength(lines[i]) > maxSessionEntryBytes)
          throw new Error("Session entry exceeds 8 MiB");
        parsed.push(JSON.parse(lines[i]));
      } catch (error) {
        if (i !== lines.length - 1 || i === 0 || raw.endsWith("\n"))
          throw new Error(`Corrupt session at line ${i + 1}: ${String(error)}`);
        repairTo = `${lines.slice(0, i).join("\n")}\n`;
      }
    }
    const h: unknown = parsed.shift();
    if (!isSessionHeader(h)) throw new Error("Unsupported session header");
    let parent: string | null = null;
    const ids = new Set<string>();
    for (const row of parsed) {
      if (!isSessionEntry(row) || ids.has(row.id) || row.parentId !== parent)
        throw new Error("Invalid session entry chain or content");
      ids.add(row.id);
      parent = row.id;
    }
    if (repairTo !== undefined) {
      copyFileSync(path, `${path}.corrupt-${Date.now()}-${randomUUID()}`);
      writeFileSync(path, repairTo, { mode: 0o600 });
    } else if (!raw.endsWith("\n")) appendFileSync(path, "\n");
    const m = new SessionManager(cwdOverride ?? h.cwd, h.id);
    m.header = { ...h, cwd: cwdOverride ?? h.cwd };
    m.file = path;
    m.entries = parsed as SessionEntry[];
    recoverStreamedToolJournal(m);
    return m;
  }
  getSessionId(): string {
    return this.header.id;
  }
  getSessionFile(): string | undefined {
    return this.store ? this.store.getFile() : this.file;
  }
  getCwd(): string {
    return this.header.cwd;
  }
  /** Move a draft into its worktree before any model messages are committed. */
  setCwd(cwd: string): void {
    if (this.storageError) throw this.storageError;
    if (this.getStateAt().lastMessageSeq || this.getStateAt().lastCompactionSeq)
      throw new Error("Cannot move a session with messages");
    const header = { ...this.header, cwd: resolve(cwd) };
    if (this.store) this.store.replace(header, this.iterateEntries());
    else this.writeTranscript(header, this.entries);
    this.header = header;
  }
  getEntries(): SessionEntry[] {
    if (this.store) throw new Error("Indexed sessions require iterateEntries or getContextEntries");
    return this.entries.slice();
  }
  getLastEntry(): SessionEntry | undefined {
    return this.store ? this.store.getTail(this.store.snapshot())?.entry : this.entries.at(-1);
  }
  /** Atomically replace a transcript after a stable fork or conversation rewind. */
  replaceEntries(source: Iterable<SessionEntry>): void {
    if (this.storageError) throw this.storageError;
    if (this.store) {
      const nonce = randomUUID();
      const remap = (id: string) =>
        createHash("sha256").update(nonce).update("\0").update(id).digest("hex").slice(0, 32);
      function* rewritten(): Iterable<SessionEntry> {
        let parentId: string | null = null;
        for (const entry of source) {
          const next: SessionEntry = { ...structuredClone(entry), id: remap(entry.id), parentId };
          if (next.type === "compaction") next.firstKeptEntryId = remap(next.firstKeptEntryId);
          if (
            next.type === "custom" &&
            next.customType === "zpi.streaming_tools" &&
            isJsonObject(next.data) &&
            typeof next.data.anchorId === "string"
          )
            next.data.anchorId = remap(next.data.anchorId);
          if (!isSessionEntry(next) || Buffer.byteLength(JSON.stringify(next)) > maxSessionEntryBytes)
            throw new Error("Invalid session entry");
          parentId = next.id;
          yield next;
        }
      }
      this.store.replace(this.header, rewritten());
      this.contextCache = undefined;
      return;
    }
    const materialized: SessionEntry[] = Array.isArray(source) ? source : Array.from(source);
    const ids = new Map(materialized.map((entry) => [entry.id, randomUUID()]));
    if (ids.size !== materialized.length) throw new Error("Duplicate session entry IDs");
    let parentId: string | null = null;
    const entries = materialized.map((entry) => {
      const id = ids.get(entry.id);
      if (!id) throw new Error("Invalid session entry identity");
      const next = { ...structuredClone(entry), id, parentId };
      if (next.type === "compaction") {
        const boundary = ids.get(next.firstKeptEntryId);
        if (!boundary) throw new Error("Invalid compaction boundary");
        next.firstKeptEntryId = boundary;
      }
      if (
        next.type === "custom" &&
        next.customType === "zpi.streaming_tools" &&
        isJsonObject(next.data) &&
        typeof next.data.anchorId === "string"
      ) {
        const anchor = ids.get(next.data.anchorId);
        if (!anchor) throw new Error("Invalid tool journal anchor");
        next.data.anchorId = anchor;
      }
      if (!isSessionEntry(next) || Buffer.byteLength(JSON.stringify(next)) > maxSessionEntryBytes)
        throw new Error("Invalid session entry");
      parentId = next.id;
      return next;
    });
    this.writeTranscript(this.header, entries);
    this.entries = entries;
    this.contextCache = undefined;
  }
  private writeTranscript(header: SessionHeader, entries: SessionEntry[]): void {
    if (!this.file) return;
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, `${[header, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
        mode: 0o600,
      });
      renameSync(temporary, this.file);
    } finally {
      rmSync(temporary, { force: true });
    }
  }
  getMicrocompactClearedIds(): string[] {
    if (!this.store) return this.entries.flatMap(microcompactClearedIds);
    const view = this.store.snapshot();
    return Array.from(this.store.readRange(1, view.endSeq, view, ["microcompact"])).flatMap(({ entry }) =>
      microcompactClearedIds(entry),
    );
  }
  buildSessionContext(snapshot?: TranscriptSnapshot): SessionContext {
    if (!this.store) return buildSessionContext(this.entries);
    const view = snapshot ?? this.store.snapshot();
    if (this.contextCache?.generation === view.generation && this.contextCache.endSeq === view.endSeq)
      return this.contextCache.context;
    const state = this.store.getStateAt(view);
    const plan = this.store.getContextPlan(view);
    const messages: Message[] = [];
    const compaction = plan.compaction;
    let start = 1;
    if (compaction) {
      const entry = compaction.entry;
      if (entry.type !== "compaction" || !entry.systemMessage)
        throw new Error("Invalid compaction: system snapshot is required");
      const boundary = this.store.readEntryById(entry.firstKeptEntryId, view);
      if (!boundary || boundary.seq !== plan.firstKeptSeq || boundary.seq >= compaction.seq)
        throw new Error("Invalid compaction boundary");
      if (boundary.entry.type === "message" && boundary.entry.message.role === "toolResult")
        throw new Error("Compaction boundary splits a tool turn");
      const summary: Message = {
        role: "user",
        synthetic: true,
        content: `Summary of earlier conversation:\n${entry.summary}`,
        timestamp: Date.parse(entry.timestamp),
      };
      setMessageProvenance(entry.systemMessage, {
        entryId: entry.id,
        seq: compaction.seq,
        kind: "compaction-system",
      });
      setMessageProvenance(summary, { entryId: entry.id, seq: compaction.seq, kind: "compaction-summary" });
      messages.push(entry.systemMessage, summary);
      start = boundary.seq;
    }
    const retainedCalls = new Set<string>();
    for (const { seq, entry } of this.store.readRange(start, view.endSeq, view, [
      "message",
      "microcompact",
    ])) {
      if (entry.type !== "message") {
        const projected = applyMicrocompactBoundary(messages, microcompactClearedIds(entry));
        messages.splice(0, messages.length, ...projected);
        continue;
      }
      if (compaction && seq < compaction.seq && entry.message.role === "system") continue;
      if (compaction) {
        if (entry.message.role === "assistant") {
          retainedCalls.clear();
          for (const part of entry.message.content) if (part.type === "toolCall") retainedCalls.add(part.id);
        } else if (entry.message.role === "toolResult" && !retainedCalls.delete(entry.message.toolCallId)) {
          throw new Error("Compaction boundary splits a tool turn: missing retained declaration");
        }
      }
      setMessageProvenance(entry.message, { entryId: entry.id, seq, kind: "message" });
      messages.push(entry.message);
    }
    const context = {
      messages,
      model: state.model,
      thinkingLevel: state.thinkingLevel,
      lastThinkingLevel: state.lastThinkingLevel,
    };
    this.contextCache = { ...view, context };
    return context;
  }
  appendMessage(message: Message): string {
    validateMessage(message);
    return this.append({ type: "message", message });
  }
  appendModelChange(provider: string, modelId: string): string {
    if (this.store) {
      if (!this.currentState) throw new Error("Indexed session requires current-state writer");
      this.currentState.setModel(provider, modelId);
      return "";
    }
    return this.append({ type: "model_change", provider, modelId });
  }
  appendThinkingLevelChange(thinkingLevel: ThinkingLevel): string {
    if (this.store) {
      if (!this.currentState) throw new Error("Indexed session requires current-state writer");
      this.currentState.setThinkingLevel(thinkingLevel);
      return "";
    }
    return this.append({ type: "thinking_level_change", thinkingLevel });
  }
  appendSessionInfo(name: string): string {
    if (this.store) {
      if (!this.currentState) throw new Error("Indexed session requires current-state writer");
      this.currentState.setName(name);
      return "";
    }
    return this.append({ type: "session_info", name });
  }
  appendMicrocompact(data: import("./microcompact.ts").MicrocompactBoundary): string {
    return this.append({ type: "microcompact", data });
  }
  appendCustomEntry(customType: string, data?: JsonValue): string {
    return this.append({ type: "custom", customType, data });
  }
  appendCompaction(
    summary: string,
    firstKeptEntryId: string,
    tokensBefore?: number,
    details?: { readFiles: string[]; modifiedFiles: string[] },
    usage?: Usage,
  ): string {
    if (!summary.trim() || !this.readEntryById(firstKeptEntryId))
      throw new Error("Invalid compaction boundary or summary");
    const current = this.buildSessionContext().messages;
    const systemMessage = collapseSystemMessages(current, Date.now());
    return this.append({
      type: "compaction",
      summary,
      firstKeptEntryId,
      tokensBefore,
      details,
      usage,
      systemMessage,
    });
  }
  private append(
    fields:
      | Omit<Extract<SessionEntry, { type: "message" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "model_change" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "thinking_level_change" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "session_info" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "custom" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "microcompact" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "compaction" }>, keyof EntryBase>,
  ): string {
    if (this.storageError) throw this.storageError;
    const entry = {
      ...fields,
      id: randomUUID(),
      parentId: this.getLastEntry()?.id ?? null,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    if (!isSessionEntry(entry)) throw new Error("Invalid session entry");
    const line = JSON.stringify(entry);
    if (Buffer.byteLength(line) > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
    try {
      if (this.store) this.store.append(entry);
      else if (this.file) {
        if (!existsSync(dirname(this.file))) throw new Error("Session directory no longer exists");
        appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
      }
    } catch (e) {
      this.storageError = new Error(`storage: ${e instanceof Error ? e.message : String(e)}`);
      throw this.storageError;
    }
    const saved = entry;
    if (!this.store) this.entries.push(saved);
    this.contextCache = undefined;
    for (const listener of this.appendListeners) listener(structuredClone(saved));
    return entry.id;
  }
}

export type CompactionEntry = Extract<SessionEntry, { type: "compaction" }>;
/** Entries are append-only. Like Pi, context projection shares immutable message records. */
export function sessionEntryToContextMessages(entry: SessionEntry): Message[] {
  return entry.type === "message" ? [entry.message] : [];
}
function collapseSystemMessages(messages: Message[], timestamp: number): SystemMessage {
  const system: SystemMessage = {
    role: "system",
    content: "",
    sections: {},
    toolsAdded: getCurrentTools(messages),
    timestamp,
  };
  for (const message of messages) {
    if (message.role !== "system") continue;
    const content =
      typeof message.content === "string" ? message.content : message.content.map((c) => c.text).join("\n");
    if (content) system.content += `${content}\n\n`;
    Object.assign(system.sections ?? {}, message.sections);
  }
  return system;
}
export function buildSessionContext(entries: SessionEntry[]): SessionContext {
  const context: SessionContext = {
    messages: [],
    thinkingLevel: "off",
    model: null,
    lastThinkingLevel: "medium",
  };
  let compactionIndex = -1;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry.type === "message")
      setMessageProvenance(entry.message, { entryId: entry.id, seq: i + 1, kind: "message" });
    if (entry.type === "compaction") compactionIndex = i;
    if (entry.type === "model_change") context.model = { provider: entry.provider, modelId: entry.modelId };
    else if (entry.type === "message" && entry.message.role === "assistant")
      context.model = { provider: entry.message.provider, modelId: entry.message.model };
    else if (entry.type === "thinking_level_change") {
      context.thinkingLevel = entry.thinkingLevel;
      if (entry.thinkingLevel !== "off") context.lastThinkingLevel = entry.thinkingLevel;
    }
  }
  const compaction = entries[compactionIndex];
  if (compaction?.type !== "compaction") {
    context.messages = applyMicrocompactBoundary(
      entries.flatMap(sessionEntryToContextMessages),
      entries.flatMap(microcompactClearedIds),
    );
    return context;
  }
  const keepIndex = entries.findIndex((e) => e.id === compaction.firstKeptEntryId);
  if (keepIndex < 0) throw new Error("Invalid compaction boundary");
  const timestamp = Date.parse(compaction.timestamp);
  const system =
    compaction.systemMessage ??
    collapseSystemMessages(
      entries.slice(0, compactionIndex).flatMap(sessionEntryToContextMessages),
      timestamp,
    );
  context.messages = [
    system,
    {
      role: "user",
      synthetic: true,
      content: `Summary of earlier conversation:\n${compaction.summary}`,
      timestamp,
    },
    ...entries
      .slice(keepIndex, compactionIndex)
      .flatMap(sessionEntryToContextMessages)
      .filter((m) => m.role !== "system"),
    ...entries.slice(compactionIndex + 1).flatMap(sessionEntryToContextMessages),
  ];
  context.messages = applyMicrocompactBoundary(context.messages, entries.flatMap(microcompactClearedIds));
  return context;
}
