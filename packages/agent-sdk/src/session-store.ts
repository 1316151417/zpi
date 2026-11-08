import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { abortable, assertSupportedOptions, contentText } from "@zpi-dev/ai";
import type { SessionEntry, SessionHeader, SessionManager } from "@zpi-dev/coding-agent";
import type { SDKMirrorErrorMessage } from "./types.ts";

export type SessionParentKey = { projectKey: string; sessionId: string };
export type SessionKey = SessionParentKey & { subpath?: string };
export type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown };
export type SessionListEntry = { sessionId: string; mtime: number };
export type SessionSummaryEntry = SessionListEntry & { data: Record<string, unknown> };
export type SessionStoreFlush = "batched" | "eager";
export interface SessionStore {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>;
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>;
  listSessions?(projectKey: string): Promise<SessionListEntry[]>;
  listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>;
  delete?(key: SessionKey): Promise<void>;
  listSubkeys?(key: SessionParentKey): Promise<string[]>;
}
export function validateId(id: string, name = "session ID"): void {
  if (typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(id)) throw new Error(`Invalid ${name}`);
}
export function validateKey(key: SessionKey): void {
  assertSupportedOptions(key, ["projectKey", "sessionId", "subpath"], "SessionKey");
  validateId(key.sessionId);
  if (
    typeof key.projectKey !== "string" ||
    !key.projectKey ||
    key.projectKey.length > 256 ||
    Array.from(key.projectKey).some((char) => char.charCodeAt(0) < 32)
  )
    throw new Error("Invalid projectKey");
  if (key.subpath !== undefined && !/^subagents\/agent-[a-zA-Z0-9_-]{1,256}$/.test(key.subpath))
    throw new Error("Invalid session subpath");
}
export function projectKey(cwd: string): string {
  const path = resolve(cwd);
  const sanitized = path.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= 200) return sanitized;
  let hash = 0;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
  return `${sanitized.slice(0, 200)}-${Math.abs(hash).toString(36)}`;
}
export function validateStore(store: SessionStore): void {
  if (!store || typeof store.append !== "function" || typeof store.load !== "function")
    throw new Error("sessionStore requires append and load");
  for (const name of ["listSessions", "listSessionSummaries", "delete", "listSubkeys"] as const)
    if (store[name] !== undefined && typeof store[name] !== "function")
      throw new Error(`Invalid sessionStore.${name}`);
}
export function foldSessionSummary(
  prev: SessionSummaryEntry | undefined,
  key: SessionKey,
  entries: SessionStoreEntry[],
  options: { mtime?: number } = {},
): SessionSummaryEntry {
  validateKey(key);
  const data = structuredClone(prev?.data ?? {});
  for (const entry of entries) {
    if (entry.type === "session") data.cwd = entry.cwd;
    if (entry.type === "session_info") data.customTitle = entry.name;
    if (entry.type === "custom" && entry.customType === "sdk.tag") data.tag = entry.data;
    if (entry.type === "message" && !data.firstPrompt) {
      const message = entry.message as {
        role?: string;
        content?: string | { type: string; text?: string }[];
      };
      if (message?.role === "user")
        data.firstPrompt = message.content === undefined ? undefined : contentText(message.content);
    }
  }
  return { sessionId: key.sessionId, mtime: options.mtime ?? prev?.mtime ?? 0, data };
}
function keyString(key: SessionKey): string {
  validateKey(key);
  return JSON.stringify([key.projectKey, key.sessionId, key.subpath ?? null]);
}
export class InMemorySessionStore implements SessionStore {
  private rows = new Map<
    string,
    { key: SessionKey; entries: SessionStoreEntry[]; ids: Set<string>; summary: SessionSummaryEntry }
  >();
  async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
    const id = keyString(key);
    const prev = this.rows.get(id);
    const ids = new Set<string>();
    const added = structuredClone(
      entries.filter((entry) => {
        if (!entry.uuid) return true;
        if (prev?.ids.has(entry.uuid) || ids.has(entry.uuid)) return false;
        ids.add(entry.uuid);
        return true;
      }),
    );
    const summary = foldSessionSummary(prev?.summary, key, added, { mtime: Date.now() });
    const row = prev ?? { key: { ...key }, entries: [], ids: new Set<string>(), summary };
    for (const entry of added) {
      row.entries.push(entry);
      if (entry.uuid) row.ids.add(entry.uuid);
    }
    row.summary = summary;
    this.rows.set(id, row);
  }
  async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
    return structuredClone(this.rows.get(keyString(key))?.entries ?? null);
  }
  getEntries(key: SessionKey): SessionStoreEntry[] {
    return structuredClone(this.rows.get(keyString(key))?.entries ?? []);
  }
  async listSessions(project: string): Promise<SessionListEntry[]> {
    return (await this.listSessionSummaries(project)).map(({ sessionId, mtime }) => ({ sessionId, mtime }));
  }
  async listSessionSummaries(project: string): Promise<SessionSummaryEntry[]> {
    return structuredClone(
      [...this.rows.values()]
        .filter((r) => r.key.projectKey === project && !r.key.subpath)
        .map((r) => r.summary),
    );
  }
  async listSubkeys(key: SessionParentKey): Promise<string[]> {
    validateKey(key);
    return [...this.rows.values()]
      .filter(
        (r) => r.key.projectKey === key.projectKey && r.key.sessionId === key.sessionId && r.key.subpath,
      )
      .map((r) => r.key.subpath as string);
  }
  async delete(key: SessionKey): Promise<void> {
    this.rows.delete(keyString(key));
  }
  clear(): void {
    this.rows.clear();
  }
}
export class StoreTimeoutError extends Error {}
export async function storeCall<T>(
  name: string,
  run: () => Promise<T>,
  timeoutMs = 60000,
  signal?: AbortSignal,
): Promise<T> {
  const timer = new AbortController();
  const timeout = setTimeout(
    () => timer.abort(new StoreTimeoutError(`${name} timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  try {
    signal?.throwIfAborted();
    return await abortable(
      Promise.resolve().then(run),
      signal ? AbortSignal.any([signal, timer.signal]) : timer.signal,
    );
  } finally {
    clearTimeout(timeout);
  }
}
// Serialize mirror streams and helper writes for the same adapter/key. Adapters own cross-process serialization.
const queues = new WeakMap<SessionStore, Map<string, Promise<void>>>();
export function orderedStoreWrite(
  store: SessionStore,
  key: SessionKey,
  run: () => Promise<void>,
): Promise<void> {
  let map = queues.get(store);
  if (!map) {
    map = new Map();
    queues.set(store, map);
  }
  const id = keyString(key),
    prior = map.get(id) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(run);
  map.set(id, next);
  void next
    .finally(() => {
      if (map?.get(id) === next) map.delete(id);
    })
    .catch(() => {});
  return next;
}
export function mirrorEntries(entries: readonly (SessionHeader | SessionEntry)[]): SessionStoreEntry[] {
  return entries.map((entry) => ({ ...structuredClone(entry), uuid: entry.id }));
}
export function transcriptEntries(manager: SessionManager): SessionStoreEntry[] {
  return mirrorEntries([manager.getHeader(), ...manager.getEntries()]);
}
export class TranscriptMirror {
  private pending: SessionStoreEntry[] = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private writes = new Set<Promise<void>>();
  private unsubscribe?: () => void;
  private store: SessionStore;
  private key: SessionKey;
  private mode: SessionStoreFlush;
  private report: (message: SDKMirrorErrorMessage) => void;
  constructor(
    store: SessionStore,
    key: SessionKey,
    mode: SessionStoreFlush,
    report: (message: SDKMirrorErrorMessage) => void,
  ) {
    validateKey(key);
    this.store = store;
    this.key = key;
    this.mode = mode;
    this.report = report;
  }
  attach(manager: SessionManager): void {
    this.enqueue(transcriptEntries(manager));
    this.unsubscribe = manager.subscribeEntries((entry) => this.enqueue([{ ...entry, uuid: entry.id }]));
  }
  // Initial snapshots and subscription entries already belong to this mirror.
  private enqueue(entries: SessionStoreEntry[]): void {
    if (this.mode === "eager") {
      this.send(entries);
      return;
    }
    this.pending.push(...entries);
    this.bytes += Buffer.byteLength(JSON.stringify(entries));
    if (this.pending.length >= 100 || this.bytes >= 256 * 1024) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), 100);
  }
  flush(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.pending.length) return;
    const entries = this.pending.splice(0);
    this.bytes = 0;
    this.send(entries);
  }
  private send(entries: SessionStoreEntry[]): void {
    const write = orderedStoreWrite(this.store, this.key, async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await storeCall("sessionStore.append", () =>
            this.store.append({ ...this.key }, structuredClone(entries)),
          );
          return;
        } catch (error) {
          if (error instanceof StoreTimeoutError || attempt === 2) {
            this.report({
              type: "system",
              subtype: "mirror_error",
              error: error instanceof Error ? error.message : String(error),
              key: { ...this.key },
              uuid: randomUUID(),
              session_id: this.key.sessionId,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
        }
      }
    });
    this.writes.add(write);
    void write.finally(() => this.writes.delete(write)).catch(() => {});
  }
  async drain(): Promise<void> {
    this.flush();
    await Promise.all(this.writes);
  }
  async close(): Promise<void> {
    this.unsubscribe?.();
    await this.drain();
  }
}
