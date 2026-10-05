import { randomUUID } from "node:crypto";
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
import type { JsonValue, Message, SystemMessage } from "zpi-ai";
import { assertSupportedOptions, getCurrentTools } from "zpi-ai";
import {
  isSessionEntry,
  isSessionHeader,
  maxSessionEntryBytes,
  validateMessage,
} from "./record-validation.ts";
export interface SessionHeader {
  type: "session";
  version: 1;
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
    | { type: "compaction"; summary: string; firstKeptEntryId: string }
    // Read-only legacy entry. It is never projected into the active context.
    | { type: "goal_change"; goal: JsonValue }
  );
export interface SessionContext {
  messages: Message[];
  thinkingLevel: ThinkingLevel;
  model: { provider: string; modelId: string } | null;
  lastThinkingLevel: ThinkingLevel;
}
export class SessionManager {
  private header: SessionHeader;
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
    return m;
  }
  getSessionId(): string {
    return this.header.id;
  }
  getSessionFile(): string | undefined {
    return this.file;
  }
  getCwd(): string {
    return this.header.cwd;
  }
  getEntries(): SessionEntry[] {
    return structuredClone(this.entries);
  }
  getLastEntry(): SessionEntry | undefined {
    return structuredClone(this.entries.at(-1));
  }
  /** Atomically replace a transcript after a stable fork or conversation rewind. */
  replaceEntries(source: SessionEntry[]): void {
    if (this.storageError) throw this.storageError;
    const ids = new Map(source.map((entry) => [entry.id, randomUUID()]));
    if (ids.size !== source.length) throw new Error("Duplicate session entry IDs");
    let parentId: string | null = null;
    const entries = source.map((entry) => {
      const id = ids.get(entry.id);
      if (!id) throw new Error("Invalid session entry identity");
      const next = { ...structuredClone(entry), id, parentId };
      if (next.type === "compaction") {
        const boundary = ids.get(next.firstKeptEntryId);
        if (!boundary) throw new Error("Invalid compaction boundary");
        next.firstKeptEntryId = boundary;
      }
      if (!isSessionEntry(next) || Buffer.byteLength(JSON.stringify(next)) > maxSessionEntryBytes)
        throw new Error("Invalid session entry");
      parentId = next.id;
      return next;
    });
    if (this.file) {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, `${[this.header, ...entries].map((e) => JSON.stringify(e)).join("\n")}\n`, {
          mode: 0o600,
        });
        renameSync(temporary, this.file);
      } finally {
        rmSync(temporary, { force: true });
      }
    }
    this.entries = entries;
  }
  buildSessionContext(): SessionContext {
    const context: SessionContext = {
      messages: [],
      thinkingLevel: "off",
      model: null,
      lastThinkingLevel: "medium",
    };
    for (const e of this.entries) {
      if (e.type === "message") {
        const message = structuredClone(e.message);
        // Ignore obsolete instructions in memory; never migrate the historical JSONL.
        if (message.role === "system" && message.sections) delete message.sections["zpi.goal"];
        context.messages.push(message);
      } else if (e.type === "model_change") context.model = { provider: e.provider, modelId: e.modelId };
      else if (e.type === "thinking_level_change") {
        context.thinkingLevel = e.thinkingLevel;
        if (e.thinkingLevel !== "off") context.lastThinkingLevel = e.thinkingLevel;
      } else if (e.type === "compaction") {
        const keepIndex = this.entries.findIndex((entry) => entry.id === e.firstKeptEntryId);
        if (keepIndex < 0) throw new Error("Invalid compaction boundary");
        const index = this.entries.indexOf(e);
        const current = context.messages;
        const system: SystemMessage = {
          role: "system",
          content: "",
          sections: {},
          toolsAdded: getCurrentTools(current),
          timestamp: Date.parse(e.timestamp),
        };
        for (const message of current) {
          if (message.role !== "system") continue;
          const content =
            typeof message.content === "string"
              ? message.content
              : message.content.map((c) => c.text).join("\n");
          if (content) system.content += `${content}\n\n`;
          Object.assign(system.sections ?? {}, message.sections);
        }
        context.messages = [
          system,
          {
            role: "user",
            content: `Summary of earlier conversation:\n${e.summary}`,
            timestamp: Date.parse(e.timestamp),
          },
          ...this.entries
            .slice(keepIndex, index)
            .flatMap((row) =>
              row.type === "message" && row.message.role !== "system" ? [structuredClone(row.message)] : [],
            ),
        ];
      }
    }
    return context;
  }
  appendMessage(message: Message): string {
    validateMessage(message);
    return this.append({ type: "message", message });
  }
  appendModelChange(provider: string, modelId: string): string {
    return this.append({ type: "model_change", provider, modelId });
  }
  appendThinkingLevelChange(thinkingLevel: ThinkingLevel): string {
    return this.append({ type: "thinking_level_change", thinkingLevel });
  }
  appendSessionInfo(name: string): string {
    return this.append({ type: "session_info", name });
  }
  appendCustomEntry(customType: string, data?: JsonValue): string {
    return this.append({ type: "custom", customType, data });
  }
  appendCompaction(summary: string, firstKeptEntryId: string): string {
    if (
      !summary.trim() ||
      !this.entries.some(
        (e) =>
          e.id === firstKeptEntryId && e.type === "message" && ["user", "assistant"].includes(e.message.role),
      )
    )
      throw new Error("Invalid compaction boundary or summary");
    return this.append({ type: "compaction", summary, firstKeptEntryId });
  }
  private append(
    fields:
      | Omit<Extract<SessionEntry, { type: "message" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "model_change" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "thinking_level_change" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "session_info" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "custom" }>, keyof EntryBase>
      | Omit<Extract<SessionEntry, { type: "compaction" }>, keyof EntryBase>,
  ): string {
    if (this.storageError) throw this.storageError;
    const entry = {
      ...fields,
      id: randomUUID(),
      parentId: this.entries.at(-1)?.id ?? null,
      timestamp: new Date().toISOString(),
    } as SessionEntry;
    if (!isSessionEntry(entry)) throw new Error("Invalid session entry");
    const line = JSON.stringify(entry);
    if (Buffer.byteLength(line) > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
    try {
      if (this.file) {
        if (!existsSync(dirname(this.file))) throw new Error("Session directory no longer exists");
        appendFileSync(this.file, `${line}\n`, { mode: 0o600 });
      }
    } catch (e) {
      this.storageError = new Error(`storage: ${e instanceof Error ? e.message : String(e)}`);
      throw this.storageError;
    }
    const saved = JSON.parse(line) as SessionEntry;
    this.entries.push(saved);
    for (const listener of this.appendListeners) listener(structuredClone(saved));
    return entry.id;
  }
}
