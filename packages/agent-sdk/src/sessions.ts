import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  applyFileRewind,
  type FileChange,
  planFileRewind,
  type SessionEntry,
  SessionManager,
} from "@zpi-dev/coding-agent";
import { assistantMessage, messageText, messageUuids, userMessage } from "./messages.ts";
import type { Options, RewindFilesResult } from "./types.ts";

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
export interface ListSessionsOptions {
  dir?: string;
  limit?: number;
  includeWorktrees?: boolean;
  zpi?: { agentDir?: string };
}
export interface SessionMessage {
  type: "user" | "assistant" | "system";
  uuid: string;
  session_id: string;
  message: unknown;
  parent_tool_use_id: string | null;
  parent_agent_id: string | null;
}
export const agentDirectory = (options?: { agentDir?: string }) =>
  resolve(options?.agentDir ?? join(homedir(), ".zpi", "sdk"));
function sessionPath(id: string, options?: { agentDir?: string }): string {
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Invalid session ID");
  return join(agentDirectory(options), "sessions", `${id}.jsonl`);
}
function sessionInfo(path: string, info: Stats, dir?: string): SDKSessionInfo | undefined {
  const manager = SessionManager.open(path);
  if (dir && resolve(manager.getCwd()) !== resolve(dir)) return undefined;
  const entries = manager.getEntries(),
    first = entries.find((entry) => entry.type === "message" && entry.message.role === "user"),
    title = entries.findLast((entry) => entry.type === "session_info"),
    tag = entries.findLast((entry) => entry.type === "custom" && entry.customType === "sdk.tag"),
    firstPrompt = first?.type === "message" ? messageText(first.message) : undefined;
  return {
    sessionId: manager.getSessionId(),
    summary: title?.type === "session_info" ? title.name : (firstPrompt?.slice(0, 120) ?? ""),
    customTitle: title?.type === "session_info" ? title.name : undefined,
    firstPrompt,
    lastModified: info.mtimeMs,
    fileSize: info.size,
    cwd: manager.getCwd(),
    ...(tag?.type === "custom" && typeof tag.data === "string" ? { tag: tag.data } : {}),
  };
}
export async function listSessions(options: ListSessionsOptions = {}): Promise<SDKSessionInfo[]> {
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 0))
    throw new Error("Invalid session limit");
  if (options.limit === 0) return [];
  const root = join(agentDirectory(options.zpi), "sessions");
  const files = await readdir(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const candidates = await Promise.all(
    files
      .filter((file) => file.endsWith(".jsonl"))
      .map(async (file) => {
        const path = join(root, file);
        return { path, info: await stat(path) };
      }),
  );
  const rows: SDKSessionInfo[] = [];
  for (const { path, info } of candidates.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs)) {
    const row = sessionInfo(path, info, options.dir);
    if (!row) continue;
    rows.push(row);
    if (options.limit !== undefined && rows.length >= options.limit) break;
  }
  return rows;
}
export async function getSessionInfo(
  sessionId: string,
  options: ListSessionsOptions = {},
): Promise<SDKSessionInfo | undefined> {
  const path = sessionPath(sessionId, options.zpi);
  try {
    return sessionInfo(path, await stat(path), options.dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
export async function getSessionMessages(
  sessionId: string,
  options: ListSessionsOptions & { limit?: number; offset?: number; includeSystemMessages?: boolean } = {},
): Promise<SessionMessage[]> {
  const manager = SessionManager.open(sessionPath(sessionId, options.zpi));
  if (options.dir && resolve(options.dir) !== resolve(manager.getCwd()))
    throw new Error("Session does not belong to dir");
  const entries = manager.getEntries(),
    ids = messageUuids(entries);
  return entries
    .filter(
      (entry): entry is Extract<SessionEntry, { type: "message" }> =>
        entry.type === "message" &&
        (entry.message.role !== "system" || options.includeSystemMessages === true),
    )
    .slice(
      options.offset ?? 0,
      options.limit === undefined ? undefined : (options.offset ?? 0) + options.limit,
    )
    .map((entry): SessionMessage => {
      const message = entry.message,
        uuid = ids.get(entry.id) as string;
      if (message.role === "system")
        return {
          type: "system",
          uuid,
          session_id: sessionId,
          message,
          parent_tool_use_id: null,
          parent_agent_id: null,
        };
      const value =
        message.role === "assistant"
          ? assistantMessage(message, sessionId, uuid)
          : userMessage(message, sessionId, uuid);
      return {
        type: value.type,
        uuid,
        session_id: sessionId,
        message: value.message,
        parent_tool_use_id: null,
        parent_agent_id: null,
      };
    });
}
export async function renameSession(
  sessionId: string,
  title: string,
  options: ListSessionsOptions = {},
): Promise<void> {
  if (!title.trim()) throw new Error("Session title cannot be empty");
  const manager = SessionManager.open(sessionPath(sessionId, options.zpi));
  manager.appendSessionInfo(title);
  await manager.flushAsync();
}
export async function tagSession(
  sessionId: string,
  tag: string | null,
  options: ListSessionsOptions = {},
): Promise<void> {
  const manager = SessionManager.open(sessionPath(sessionId, options.zpi));
  await manager.appendCustomEntryAsync("sdk.tag", tag ?? "");
}
export async function forkSession(
  sessionId: string,
  options: ListSessionsOptions & { upToMessageId?: string; title?: string } = {},
): Promise<{ sessionId: string }> {
  const source = SessionManager.open(sessionPath(sessionId, options.zpi));
  const entries = source.getEntries(),
    ids = messageUuids(entries);
  const index = options.upToMessageId
    ? entries.findIndex((entry) => ids.get(entry.id) === options.upToMessageId)
    : entries.length - 1;
  if (index < 0) throw new Error("Message not found");
  const target = SessionManager.create(source.getCwd(), join(agentDirectory(options.zpi), "sessions"));
  target.replaceEntries(
    entries.slice(0, index + 1).map((entry) => {
      if (
        entry.type !== "message" ||
        entry.message.role !== "toolResult" ||
        !entry.message.details ||
        typeof entry.message.details !== "object"
      )
        return entry;
      const { fileChange: _, ...details } = entry.message.details as import("@zpi-dev/ai").JsonObject;
      return { ...entry, message: { ...entry.message, details } };
    }),
  );
  if (options.title) target.appendSessionInfo(options.title);
  return { sessionId: target.getSessionId() };
}
export async function openSession(options: Options, cwd: string): Promise<SessionManager> {
  const directory = join(agentDirectory(options.zpi), "sessions");
  if (options.persistSession === false) {
    if (options.resume || options.continue || options.forkSession)
      throw new Error("In-memory sessions cannot resume or fork");
    return SessionManager.inMemory(cwd, { id: options.sessionId });
  }
  let id = options.resume;
  if (options.continue && id) throw new Error("Use resume or continue, not both");
  if (options.continue) id = (await listSessions({ dir: cwd, limit: 1, zpi: options.zpi }))[0]?.sessionId;
  if (options.forkSession && !id) throw new Error("forkSession requires resume or an existing conversation");
  if (id && options.forkSession)
    id = (await forkSession(id, { zpi: options.zpi, upToMessageId: options.resumeSessionAt })).sessionId;
  if (!id) return SessionManager.create(cwd, directory, { id: options.sessionId });
  const manager = SessionManager.open(sessionPath(id, options.zpi), undefined, cwd);
  if (options.resumeSessionAt && !options.forkSession) {
    const entries = manager.getEntries(),
      ids = messageUuids(entries),
      index = entries.findIndex((entry) => ids.get(entry.id) === options.resumeSessionAt);
    if (index < 0) throw new Error("resumeSessionAt message not found");
    manager.replaceEntries(entries.slice(0, index + 1));
  }
  return manager;
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
