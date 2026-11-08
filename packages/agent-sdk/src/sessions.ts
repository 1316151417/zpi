import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { assertSupportedOptions } from "@zpi-dev/ai";
import {
  applyFileRewind,
  decodeSessionTranscript,
  type FileChange,
  parseSessionTranscript,
  planFileRewind,
  type SessionEntry,
  SessionManager,
} from "@zpi-dev/coding-agent";
import { assistantMessage, messageText, messageUuids, userMessage } from "./messages.ts";
import {
  mirrorEntries,
  orderedStoreWrite,
  projectKey,
  type SessionKey,
  type SessionStore,
  type SessionStoreEntry,
  storeCall,
  transcriptEntries,
  validateId,
  validateKey,
  validateStore,
} from "./session-store.ts";
import type { Options, RewindFilesResult } from "./types.ts";
import { zpiOptionKeys } from "./validation.ts";

export interface SDKSessionInfo {
  sessionId: string;
  summary: string;
  lastModified: number;
  fileSize?: number;
  customTitle?: string;
  firstPrompt?: string;
  cwd?: string;
  tag?: string;
}
export interface SessionMutationOptions {
  dir?: string;
  sessionStore?: SessionStore;
  loadTimeoutMs?: number;
  zpi?: { agentDir?: string; projectKey?: string };
}
export interface ListSessionsOptions extends SessionMutationOptions {
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
}
export interface GetSessionMessagesOptions extends SessionMutationOptions {
  limit?: number;
  offset?: number;
  includeSystemMessages?: boolean;
}
export type GetSubagentMessagesOptions = Omit<GetSessionMessagesOptions, "includeSystemMessages">;
export type ListSubagentsOptions = SessionMutationOptions;
export type GetSessionInfoOptions = ListSessionsOptions;
export interface ForkSessionOptions extends SessionMutationOptions {
  upToMessageId?: string;
  title?: string;
}
export interface SessionMessage {
  /** ZPI diagnostic from a failed or aborted historical assistant response. */
  error?: string;
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
}
export interface ChildRecord {
  parentSessionId: string;
  agentId: string;
  parentToolUseId: string;
  parentAgentId?: string;
}
export const agentDirectory = (options?: { agentDir?: string }) =>
  resolve(options?.agentDir ?? join(homedir(), ".zpi", "sdk"));
export function sessionPath(id: string, options?: { agentDir?: string }, agentId?: string): string {
  validateId(id);
  if (agentId !== undefined) validateId(agentId, "agent ID");
  return agentId === undefined
    ? join(agentDirectory(options), "sessions", `${id}.jsonl`)
    : join(agentDirectory(options), "sessions", id, "subagents", `agent-${agentId}.jsonl`);
}
function validateOptions(options: ListSessionsOptions & { includeSystemMessages?: boolean }): void {
  assertSupportedOptions(
    options,
    [
      "dir",
      "sessionStore",
      "loadTimeoutMs",
      "zpi",
      "limit",
      "offset",
      "includeWorktrees",
      "includeSystemMessages",
      "upToMessageId",
      "title",
    ],
    "session options",
  );
  if (options.zpi) assertSupportedOptions(options.zpi, zpiOptionKeys, "session zpi options");
  for (const name of ["limit", "offset"] as const)
    if (options[name] !== undefined && (!Number.isSafeInteger(options[name]) || Number(options[name]) < 0))
      throw new Error(`Invalid session ${name}`);
  if (options.includeWorktrees !== undefined && options.includeWorktrees !== false)
    throw new Error("includeWorktrees is not supported");
  if (options.dir !== undefined && (typeof options.dir !== "string" || !options.dir.trim()))
    throw new Error("Invalid session dir");
  if (
    options.loadTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.loadTimeoutMs) || options.loadTimeoutMs <= 0)
  )
    throw new Error("Invalid loadTimeoutMs");
  if (options.sessionStore) validateStore(options.sessionStore);
}
function storeKey(id: string, options: SessionMutationOptions, agentId?: string): SessionKey {
  const key: SessionKey = {
    projectKey: options.zpi?.projectKey ?? projectKey(options.dir ?? process.cwd()),
    sessionId: id,
    ...(agentId === undefined ? {} : { subpath: `subagents/agent-${agentId}` }),
  };
  validateKey(key);
  return key;
}
const storeIds = new WeakMap<SessionStore, number>();
let storeCounter = 0;
const active = new Set<string>();
function identity(id: string, options: SessionMutationOptions): string {
  if (!options.sessionStore) return sessionPath(id, options.zpi);
  let storeId = storeIds.get(options.sessionStore);
  if (!storeId) {
    storeId = ++storeCounter;
    storeIds.set(options.sessionStore, storeId);
  }
  return `${storeId}:${JSON.stringify(storeKey(id, options))}`;
}
function reserve(id: string, options: SessionMutationOptions): () => void {
  const keys = [...new Set([identity(id, options), sessionPath(id, options.zpi)])];
  if (keys.some((key) => active.has(key))) throw new Error("Session is active or being mutated");
  for (const key of keys) active.add(key);
  return () => {
    for (const key of keys) active.delete(key);
  };
}
async function exclusive<T>(id: string, options: SessionMutationOptions, run: () => Promise<T>): Promise<T> {
  validateOptions(options);
  const release = reserve(id, options);
  try {
    return await run();
  } finally {
    release();
  }
}
function validateTranscript(records: SessionStoreEntry[], id: string) {
  const parsed = decodeSessionTranscript(records);
  if (parsed.header.id !== id) throw new Error("Invalid sessionStore transcript header");
  return parsed;
}
function decode(records: SessionStoreEntry[], id: string): SessionManager {
  const { header, entries } = validateTranscript(records, id);
  return SessionManager.inMemory(header.cwd, { id }, entries);
}
async function load(
  id: string,
  options: SessionMutationOptions,
  agentId?: string,
  writable = false,
): Promise<SessionManager | undefined> {
  validateId(id);
  if (agentId !== undefined) validateId(agentId, "agent ID");
  validateOptions(options);
  let manager: SessionManager;
  const store = options.sessionStore;
  if (store) {
    const entries = await storeCall(
      "sessionStore.load",
      () => store.load(storeKey(id, options, agentId)),
      options.loadTimeoutMs,
    );
    if (entries === null || (Array.isArray(entries) && entries.length === 0)) return undefined;
    if (!Array.isArray(entries)) throw new Error("Invalid sessionStore.load result");
    const headerId = agentId === undefined ? id : entries[0]?.id;
    if (typeof headerId !== "string") throw new Error("Invalid subagent header");
    manager = decode(entries, headerId);
  } else {
    const path = sessionPath(id, options.zpi, agentId);
    try {
      if (writable) manager = SessionManager.open(path);
      else {
        const { header, entries } = parseSessionTranscript(await readFile(path, "utf8"));
        manager = SessionManager.inMemory(header.cwd, { id: header.id }, entries);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      if (writable) throw error;
      throw new Error(`Corrupt session: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
    if (agentId === undefined && manager.getSessionId() !== id)
      throw new Error("Session ID does not match transcript");
  }
  if (options.dir && resolve(manager.getCwd()) !== resolve(options.dir)) return undefined;
  return manager;
}
function info(manager: SessionManager, mtime: number, size?: number): SDKSessionInfo {
  const entries = manager.getEntries(),
    first = entries.find((e) => e.type === "message" && e.message.role === "user"),
    title = entries.findLast((e) => e.type === "session_info"),
    tag = entries.findLast((e) => e.type === "custom" && e.customType === "sdk.tag");
  const firstPrompt = first?.type === "message" ? messageText(first.message) : undefined;
  return {
    sessionId: manager.getSessionId(),
    summary: title?.type === "session_info" ? title.name : (firstPrompt?.slice(0, 120) ?? ""),
    customTitle: title?.type === "session_info" ? title.name : undefined,
    firstPrompt,
    lastModified: mtime,
    ...(size === undefined ? {} : { fileSize: size }),
    cwd: manager.getCwd(),
    ...(tag?.type === "custom" && typeof tag.data === "string" ? { tag: tag.data } : {}),
  };
}
export async function listSessions(options: ListSessionsOptions = {}): Promise<SDKSessionInfo[]> {
  validateOptions(options);
  if (options.limit === 0) return [];
  const rows: SDKSessionInfo[] = [];
  if (options.sessionStore) {
    const store = options.sessionStore,
      project = storeKey("listing", options).projectKey;
    const listSummaries = store.listSessionSummaries?.bind(store);
    if (listSummaries) {
      const summaries = await storeCall(
        "sessionStore.listSessionSummaries",
        () => listSummaries(project),
        options.loadTimeoutMs,
      );
      for (const row of summaries) {
        validateId(row.sessionId);
        if (!Number.isSafeInteger(row.mtime) || row.mtime < 0 || !row.data || typeof row.data !== "object")
          throw new Error("Invalid session summary");
        const d = row.data;
        if (options.dir && d.cwd !== resolve(options.dir)) continue;
        rows.push({
          sessionId: row.sessionId,
          lastModified: row.mtime,
          summary:
            typeof d.customTitle === "string"
              ? d.customTitle
              : typeof d.firstPrompt === "string"
                ? d.firstPrompt.slice(0, 120)
                : "",
          ...(typeof d.customTitle === "string" ? { customTitle: d.customTitle } : {}),
          ...(typeof d.firstPrompt === "string" ? { firstPrompt: d.firstPrompt } : {}),
          ...(typeof d.cwd === "string" ? { cwd: d.cwd } : {}),
          ...(typeof d.tag === "string" ? { tag: d.tag } : {}),
        });
      }
    } else {
      const listStored = store.listSessions?.bind(store);
      if (!listStored) throw new Error("sessionStore.listSessions is not supported");
      const list = await storeCall(
        "sessionStore.listSessions",
        () => listStored(project),
        options.loadTimeoutMs,
      );
      for (const row of list) {
        validateId(row.sessionId);
        if (!Number.isSafeInteger(row.mtime) || row.mtime < 0) throw new Error("Invalid session mtime");
      }
      const sorted = list.toSorted((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId));
      const batchSize = options.limit === undefined ? 8 : 1;
      for (let start = 0; start < sorted.length; start += batchSize) {
        const batch = await Promise.all(
          sorted.slice(start, start + batchSize).map(async (row) => {
            const manager = await load(row.sessionId, options);
            return manager ? info(manager, row.mtime) : undefined;
          }),
        );
        rows.push(...batch.filter((row) => row !== undefined));
        if (options.limit !== undefined && rows.length >= (options.offset ?? 0) + options.limit) break;
      }
    }
  } else {
    const root = join(agentDirectory(options.zpi), "sessions");
    const files = await readdir(root).catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    });
    const candidates = await Promise.all(
      files
        .filter((f) => f.endsWith(".jsonl"))
        .map(async (f) => ({ id: f.slice(0, -6), stats: await stat(join(root, f)) })),
    );
    for (const row of candidates.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs)) {
      const manager = await load(row.id, options);
      if (manager) rows.push(info(manager, row.stats.mtimeMs, row.stats.size));
      if (options.limit !== undefined && rows.length >= (options.offset ?? 0) + options.limit) break;
    }
  }
  rows.sort((a, b) => b.lastModified - a.lastModified || a.sessionId.localeCompare(b.sessionId));
  return rows.slice(
    options.offset ?? 0,
    options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
  );
}
export async function getSessionInfo(
  id: string,
  options: GetSessionInfoOptions = {},
): Promise<SDKSessionInfo | undefined> {
  const manager = await load(id, options);
  if (!manager) return undefined;
  if (!options.sessionStore) {
    const stats = await stat(sessionPath(id, options.zpi));
    return info(manager, stats.mtimeMs, stats.size);
  }
  // The store may omit a listing capability; transcript ISO timestamps are not storage mtimes.
  const listSummaries = options.sessionStore.listSessionSummaries?.bind(options.sessionStore);
  const listStored = options.sessionStore.listSessions?.bind(options.sessionStore);
  const project = storeKey(id, options).projectKey;
  const rows = listSummaries
    ? await storeCall(
        "sessionStore.listSessionSummaries",
        () => listSummaries(project),
        options.loadTimeoutMs,
      )
    : listStored
      ? await storeCall("sessionStore.listSessions", () => listStored(project), options.loadTimeoutMs)
      : [];
  return info(manager, rows.find((r) => r.sessionId === id)?.mtime ?? 0);
}
function messages(
  manager: SessionManager,
  sessionId: string,
  options: GetSessionMessagesOptions,
): SessionMessage[] {
  const entries = manager.getEntries(),
    ids = messageUuids(entries);
  const parent = entries.find((e) => e.type === "custom" && e.customType === "sdk.parent");
  const data =
    parent?.type === "custom"
      ? (parent.data as { parentToolUseId?: string; parentAgentId?: string })
      : undefined;
  return entries
    .filter(
      (e): e is Extract<SessionEntry, { type: "message" }> =>
        e.type === "message" && (e.message.role !== "system" || options.includeSystemMessages === true),
    )
    .slice(
      options.offset ?? 0,
      options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
    )
    .map((e) => {
      const uuid = ids.get(e.id) as string;
      const value =
        e.message.role === "system"
          ? { type: "system" as const, message: e.message }
          : e.message.role === "assistant"
            ? assistantMessage(e.message, sessionId, uuid)
            : userMessage(e.message, sessionId, uuid);
      return {
        type: value.type,
        uuid,
        session_id: sessionId,
        message: value.message,
        parent_tool_use_id: data?.parentToolUseId ?? null,
        parent_agent_id: data?.parentAgentId ?? null,
        ...(e.message.role === "assistant" && e.message.errorMessage
          ? { error: e.message.errorMessage }
          : {}),
      };
    });
}
export async function getSessionMessages(
  id: string,
  options: GetSessionMessagesOptions = {},
): Promise<SessionMessage[]> {
  const manager = await load(id, options);
  return manager ? messages(manager, id, options) : [];
}
function assertSdkMutation(manager: SessionManager): void {
  if (manager.getEntries().some((entry) => entry.type === "custom" && entry.customType === "zpi.agent_call"))
    throw new Error("Desktop sessions require their owning host service");
}
async function mutation(
  id: string,
  options: SessionMutationOptions,
  change: (manager: SessionManager) => Promise<void>,
): Promise<void> {
  await exclusive(id, options, async () => {
    const manager = await load(id, options, undefined, true);
    if (!manager) throw new Error("Session not found or does not belong to dir");
    assertSdkMutation(manager);
    const before = manager.getEntries().length;
    await change(manager);
    await manager.flushAsync();
    const store = options.sessionStore;
    if (store)
      await orderedStoreWrite(store, storeKey(id, options), () =>
        storeCall(
          "sessionStore.append",
          () => store.append(storeKey(id, options), mirrorEntries(manager.getEntries().slice(before))),
          options.loadTimeoutMs,
        ),
      );
  });
}
export async function renameSession(
  id: string,
  title: string,
  options: SessionMutationOptions = {},
): Promise<void> {
  if (typeof title !== "string" || !title.trim()) throw new Error("Session title cannot be empty");
  await mutation(id, options, async (manager) => {
    manager.appendSessionInfo(title);
  });
}
export async function tagSession(
  id: string,
  tag: string | null,
  options: SessionMutationOptions = {},
): Promise<void> {
  if (tag !== null && typeof tag !== "string") throw new Error("Invalid session tag");
  await mutation(id, options, async (manager) => {
    await manager.appendCustomEntryAsync("sdk.tag", tag ?? "");
  });
}
export async function listSubagents(id: string, options: ListSubagentsOptions = {}): Promise<string[]> {
  if (!(await load(id, options))) return [];
  return subagentIds(id, options);
}
async function subagentIds(id: string, options: ListSubagentsOptions): Promise<string[]> {
  let paths: string[];
  if (options.sessionStore) {
    const listKeys = options.sessionStore.listSubkeys?.bind(options.sessionStore);
    if (!listKeys) throw new Error("sessionStore.listSubkeys is not supported");
    paths = await storeCall(
      "sessionStore.listSubkeys",
      () => listKeys(storeKey(id, options)),
      options.loadTimeoutMs,
    );
    for (const subpath of paths) validateKey({ ...storeKey(id, options), subpath });
    return [...new Set(paths.map((p) => p.slice("subagents/agent-".length)))].sort();
  }
  paths = await readdir(join(agentDirectory(options.zpi), "sessions", id, "subagents")).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return [];
      throw e;
    },
  );
  return paths
    .filter((p) => /^agent-[a-zA-Z0-9_-]+\.jsonl$/.test(p))
    .map((p) => p.slice(6, -6))
    .sort();
}
export async function getSubagentMessages(
  id: string,
  agentId: string,
  options: GetSubagentMessagesOptions = {},
): Promise<SessionMessage[]> {
  const manager = await load(id, options, agentId);
  return manager ? messages(manager, id, options) : [];
}
export async function deleteSession(id: string, options: SessionMutationOptions = {}): Promise<void> {
  await exclusive(id, options, async () => {
    const manager = await load(id, options);
    if (!manager) return;
    assertSdkMutation(manager);
    if (options.sessionStore) {
      const store = options.sessionStore;
      const remove = store.delete?.bind(store);
      if (!remove) throw new Error("sessionStore.delete is not supported");
      if (!store.listSubkeys)
        throw new Error("sessionStore.listSubkeys is required to delete a session tree");
      for (const agent of await subagentIds(id, options))
        await orderedStoreWrite(store, storeKey(id, options, agent), () =>
          storeCall("sessionStore.delete", () => remove(storeKey(id, options, agent)), options.loadTimeoutMs),
        );
      await orderedStoreWrite(store, storeKey(id, options), () =>
        storeCall("sessionStore.delete", () => remove(storeKey(id, options)), options.loadTimeoutMs),
      );
    } else {
      await rm(join(agentDirectory(options.zpi), "sessions", id), { recursive: true, force: true });
      await rm(sessionPath(id, options.zpi), { force: true });
    }
  });
}
function forkEntries(entries: SessionEntry[]): { entries: SessionEntry[]; calls: Map<string, string> } {
  const calls = new Map<string, string>();
  for (const entry of entries)
    if (entry.type === "message" && entry.message.role === "assistant")
      for (const block of entry.message.content)
        if (block.type === "toolCall") calls.set(block.id, randomUUID());
  const remapped = entries
    .filter(
      (e) =>
        !(e.type === "custom" && ["sdk.user", "sdk.result", "zpi.streaming_tools"].includes(e.customType)),
    )
    .map((e) => {
      const entry = structuredClone(e);
      if (entry.type === "message" && entry.message.role === "assistant")
        for (const block of entry.message.content)
          if (block.type === "toolCall") block.id = calls.get(block.id) ?? block.id;
      // The fork owns fresh identities; the source client's input association must not carry over.
      if (entry.type === "message" && entry.message.role === "user") delete entry.message.inputId;
      if (entry.type === "message" && entry.message.role === "toolResult") {
        entry.message.toolCallId = calls.get(entry.message.toolCallId) ?? entry.message.toolCallId;
        if (entry.message.details && typeof entry.message.details === "object") {
          const { fileChange: _, ...details } = entry.message.details as import("@zpi-dev/ai").JsonObject;
          entry.message.details = details;
        }
      }
      if (entry.type === "microcompact") {
        entry.data.clearedToolCallIds = entry.data.clearedToolCallIds.map((id) => calls.get(id) ?? id);
        entry.data.keptToolCallIds = entry.data.keptToolCallIds.map((id) => calls.get(id) ?? id);
      }
      if (entry.type === "custom" && entry.customType === "sdk.child_usage") {
        const data = entry.data as unknown as { agentId: string };
        if (data && calls.has(data.agentId))
          entry.data = {
            ...(entry.data as import("@zpi-dev/ai").JsonObject),
            agentId: calls.get(data.agentId) ?? data.agentId,
          };
      }
      return entry;
    });
  return { entries: remapped, calls };
}
export async function forkSession(
  id: string,
  options: ForkSessionOptions = {},
): Promise<{ sessionId: string }> {
  return exclusive(id, options, async () => {
    const source = await load(id, options);
    if (!source) throw new Error("Session not found or does not belong to dir");
    assertSdkMutation(source);
    if (options.sessionStore && !options.sessionStore.listSubkeys)
      throw new Error("sessionStore.listSubkeys is required to fork a session tree");
    if (options.title !== undefined && (typeof options.title !== "string" || !options.title.trim()))
      throw new Error("Session title cannot be empty");
    const all = source.getEntries(),
      ids = messageUuids(all);
    const index = options.upToMessageId
      ? all.findIndex((e) => ids.get(e.id) === options.upToMessageId)
      : all.length - 1;
    if (options.upToMessageId && index < 0) throw new Error("Message not found");
    const targetId = randomUUID(),
      target = SessionManager.inMemory(source.getCwd(), { id: targetId });
    const selected = all.slice(0, index + 1);
    const { entries: remapped, calls: mapping } = forkEntries(selected);
    target.replaceEntries(remapped);
    if (options.title) target.appendSessionInfo(options.title);
    const childAgents = await subagentIds(id, options);
    const children: { id: string; entries: SessionStoreEntry[] }[] = [];
    for (const agentId of childAgents) {
      const child = await load(id, options, agentId);
      if (!child) continue;
      const parent = child.getEntries().find((e) => e.type === "custom" && e.customType === "sdk.parent");
      const link = parent?.type === "custom" ? (parent.data as unknown as ChildRecord) : undefined;
      if (
        !link ||
        !mapping.has(link.parentToolUseId) ||
        !selected.some(
          (e) =>
            e.type === "message" &&
            e.message.role === "toolResult" &&
            e.message.toolCallId === link.parentToolUseId,
        )
      )
        continue;
      const newAgentId = mapping.get(link.parentToolUseId);
      if (!newAgentId) throw new Error("Invalid fork tool association");
      const clone = SessionManager.inMemory(child.getCwd(), { id: randomUUID() });
      clone.replaceEntries(
        forkEntries(child.getEntries()).entries.map((e) =>
          e.type === "custom" && e.customType === "sdk.parent"
            ? {
                ...e,
                data: {
                  ...link,
                  parentSessionId: targetId,
                  agentId: newAgentId,
                  parentToolUseId: newAgentId,
                },
              }
            : e,
        ),
      );
      children.push({ id: newAgentId, entries: transcriptEntries(clone) });
    }
    await target.flushAsync();
    const store = options.sessionStore;
    const written: SessionKey[] = [];
    try {
      for (const transcript of [...children, { id: undefined, entries: transcriptEntries(target) }]) {
        if (store) {
          const key = storeKey(targetId, options, transcript.id);
          written.push(key);
          await orderedStoreWrite(store, key, () =>
            storeCall(
              "sessionStore.append",
              () => store.append(key, transcript.entries),
              options.loadTimeoutMs,
            ),
          );
        } else {
          const path = sessionPath(targetId, options.zpi, transcript.id);
          if (transcript.id !== undefined) await mkdir(dirname(path), { recursive: true });
          await writeFile(path, `${transcript.entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
            mode: 0o600,
            flag: "wx",
          });
        }
      }
    } catch (error) {
      if (store) {
        const remove = store.delete?.bind(store);
        if (remove)
          await Promise.allSettled(
            written.map((key) =>
              orderedStoreWrite(store, key, () =>
                storeCall("sessionStore.delete", () => remove(key), options.loadTimeoutMs),
              ),
            ),
          );
      } else {
        await rm(join(agentDirectory(options.zpi), "sessions", targetId), { recursive: true, force: true });
      }
      throw Object.assign(
        new Error(
          `Session fork failed (${targetId}): ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
        { sessionId: targetId },
      );
    }
    return { sessionId: targetId };
  });
}
function materialized(entries: SessionStoreEntry[]): string {
  return `${entries
    .map((entry) => {
      const { uuid, ...native } = entry;
      return JSON.stringify(uuid === entry.id ? native : entry);
    })
    .join("\n")}\n`;
}
export interface OpenedSession {
  manager: SessionManager;
  key?: SessionKey;
  cleanup(): Promise<void>;
}
export async function openSession(
  options: Options,
  cwd: string,
  child?: ChildRecord,
  signal?: AbortSignal,
): Promise<OpenedSession> {
  const helper: SessionMutationOptions = {
    dir: cwd,
    zpi: options.zpi,
    sessionStore: options.sessionStore,
    loadTimeoutMs: options.loadTimeoutMs,
  };
  validateOptions(helper);
  if (options.persistSession === false) {
    if (options.resume || options.continue || options.forkSession || options.sessionStore)
      throw new Error("In-memory sessions cannot resume, fork or mirror");
    return { manager: SessionManager.inMemory(cwd, { id: options.sessionId }), cleanup: async () => {} };
  }
  let id = options.resume;
  if (options.continue && id) throw new Error("Use resume or continue, not both");
  if (options.continue) {
    const store = options.sessionStore;
    if (store) {
      const list = store.listSessions;
      if (!list) throw new Error("continue with sessionStore requires listSessions");
      const rows = await storeCall(
        "sessionStore.listSessions",
        () => list.call(store, storeKey("listing", helper).projectKey),
        options.loadTimeoutMs,
        signal,
      );
      for (const row of rows) {
        validateId(row.sessionId);
        if (!Number.isSafeInteger(row.mtime) || row.mtime < 0) throw new Error("Invalid session mtime");
      }
      id = rows
        .slice()
        .sort((a, b) => b.mtime - a.mtime || a.sessionId.localeCompare(b.sessionId))[0]?.sessionId;
    } else id = (await listSessions({ ...helper, limit: 1 }))[0]?.sessionId;
  }
  if (options.forkSession && !id) throw new Error("forkSession requires resume or an existing conversation");
  if (options.forkSession && id)
    id = (await forkSession(id, { ...helper, upToMessageId: options.resumeSessionAt })).sessionId;
  const recordId = child?.parentSessionId ?? id ?? options.sessionId ?? randomUUID();
  const release = child ? () => {} : reserve(recordId, helper);
  let temporary: string | undefined;
  try {
    let manager: SessionManager;
    const key = options.sessionStore ? storeKey(recordId, helper, child?.agentId) : undefined;
    const store = options.sessionStore;
    if (options.sessionId && store && key) {
      const existing = await storeCall(
        "sessionStore.load",
        () => store.load(key),
        options.loadTimeoutMs,
        signal,
      );
      if (existing?.length) throw new Error("Session already exists in sessionStore; use resume");
    }
    if (id && store && key) {
      const entries = await storeCall(
        "sessionStore.load",
        () => store.load(key),
        options.loadTimeoutMs,
        signal,
      );
      if (entries !== null && entries.length > 0) {
        validateTranscript(entries, id);
        temporary = await mkdtemp(join(tmpdir(), "zpi-sdk-restore-"));
        const path = join(temporary, `${id}.jsonl`);
        await writeFile(path, materialized(entries), { mode: 0o600 });
        const listKeys = store.listSubkeys?.bind(store);
        if (listKeys)
          for (const subpath of await storeCall(
            "sessionStore.listSubkeys",
            () => listKeys(storeKey(recordId, helper)),
            options.loadTimeoutMs,
            signal,
          )) {
            validateKey({ ...key, subpath });
            const data = await storeCall(
              "sessionStore.load",
              () => store.load({ ...key, subpath }),
              options.loadTimeoutMs,
              signal,
            );
            if (data) {
              const headerId = data[0]?.id;
              if (typeof headerId !== "string") throw new Error("Invalid subagent header");
              validateTranscript(data, headerId);
              const childPath = join(temporary, id, `${subpath}.jsonl`);
              await mkdir(dirname(childPath), { recursive: true });
              await writeFile(childPath, materialized(data), {
                mode: 0o600,
              });
            }
          }
        manager = SessionManager.open(path, undefined, cwd);
      } else manager = SessionManager.open(sessionPath(id, options.zpi), undefined, cwd);
    } else if (id) manager = SessionManager.open(sessionPath(id, options.zpi), undefined, cwd);
    else if (child) {
      const path = sessionPath(child.parentSessionId, options.zpi, child.agentId);
      await mkdir(dirname(path), { recursive: true });
      const header = {
        type: "session",
        version: 1,
        format: "zpi",
        id: child.agentId,
        timestamp: new Date().toISOString(),
        cwd: resolve(cwd),
      };
      await writeFile(path, `${JSON.stringify(header)}\n`, { mode: 0o600, flag: "wx" });
      manager = SessionManager.open(path);
      await manager.appendCustomEntryAsync("sdk.parent", { ...child });
    } else
      manager = SessionManager.create(cwd, join(agentDirectory(options.zpi), "sessions"), { id: recordId });
    if (options.resumeSessionAt && !options.forkSession) {
      if (options.sessionStore) throw new Error("resumeSessionAt with sessionStore requires forkSession");
      const entries = manager.getEntries(),
        ids = messageUuids(entries),
        index = entries.findIndex((e) => ids.get(e.id) === options.resumeSessionAt);
      if (index < 0) throw new Error("resumeSessionAt message not found");
      manager.replaceEntries(entries.slice(0, index + 1));
    }
    return {
      manager,
      key,
      cleanup: async () => {
        try {
          if (temporary) await rm(temporary, { recursive: true, force: true });
        } finally {
          release();
        }
      },
    };
  } catch (e) {
    release();
    if (temporary) await rm(temporary, { recursive: true, force: true });
    throw e;
  }
}
export async function rewindFiles(
  manager: SessionManager,
  userMessageId: string,
  dryRun = false,
): Promise<RewindFilesResult> {
  const entries = manager.getEntries(),
    ids = messageUuids(entries),
    index = entries.findIndex(
      (entry) =>
        ids.get(entry.id) === userMessageId && entry.type === "message" && entry.message.role === "user",
    );
  if (index < 0) return { canRewind: false, error: "User message not found" };
  const changes: FileChange[] = [];
  for (const entry of entries.slice(index + 1)) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    const details = entry.message.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) continue;
    const change = (details as { fileChange?: FileChange }).fileChange;
    if (change) changes.push(change);
  }
  try {
    const plan = await planFileRewind(changes);
    const conflicts = dryRun ? plan.conflicts : await applyFileRewind(plan, () => {});
    if (conflicts.length)
      return {
        canRewind: false,
        error: conflicts.map(({ path, reason }) => `${path}: ${reason}`).join("\n"),
      };
    return { canRewind: true, filesChanged: plan.files.map((file) => file.path) };
  } catch (error) {
    return { canRewind: false, error: error instanceof Error ? error.message : String(error) };
  }
}
