import type { SQLOutputValue } from "node:sqlite";
import type { TaskState } from "./state-store.ts";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string";
const nonempty = (value: unknown) => string(value) && (value as string).length > 0;
const number = (value: unknown) => typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0;
const nullableId = (value: unknown) => value === null || nonempty(value);

/** Validate before use. Diagnostics name fields, never include task text or other payload values. */
export function validateTask(value: unknown, id: string): asserts value is TaskState {
  const fail = (field: string): never => {
    throw new Error(`storage: invalid task ${JSON.stringify(id)}: ${field}`);
  };
  if (!object(value)) fail("data must be an object");
  const data = value as Record<string, unknown>;
  const required: Record<string, (value: unknown) => boolean> = {
    id: (v) => string(v) && /^[a-zA-Z0-9_-]+$/.test(String(v)),
    projectId: nullableId,
    title: string,
    createdAt: integer,
    updatedAt: integer,
  };
  for (const [field, check] of Object.entries(required))
    if (!check(data[field])) fail(`${field} missing or invalid type`);
  if (data.id !== id) fail("id does not match SQL primary key");
  const optional: Record<string, (value: unknown) => boolean> = {
    parentSessionId: nonempty,
    groupId: nullableId,
    sortKey: number,
    revision: integer,
    cwd: nonempty,
    sessionFile: nonempty,
    titleState: string,
    worktreeBaseRef: string,
    diagnostic: string,
    newWorktree: (v) => typeof v === "boolean",
    draft: (v) => typeof v === "boolean",
    queuePaused: (v) => typeof v === "boolean",
    activitySeq: integer,
    unreadAt: integer,
    pinnedAt: (v) => v === null || integer(v),
    archivedAt: (v) => v === null || integer(v),
    status: (v) =>
      ["running", "completed", "aborted", "error", "interrupted"].includes(String(v)) && string(v),
    lastThinkingLevel: nonempty,
    currentSelection: (v) => object(v) && nonempty(v.provider) && nonempty(v.modelId) && string(v.reasoning),
    fork: (v) => object(v) && nonempty(v.sessionId) && nonempty(v.runId),
    worktree: (v) =>
      object(v) &&
      nonempty(v.path) &&
      nonempty(v.sourceCwd) &&
      (v.id === undefined || string(v.id)) &&
      (v.branch === undefined || string(v.branch)),
    // The host validates the configuration's capability/template contract before restoring execution.
    frozenConfiguration: object,
  };
  for (const [field, check] of Object.entries(optional))
    if (data[field] !== undefined && !check(data[field])) fail(`${field} invalid type or value`);
}

export function taskFromRow(row: Record<string, SQLOutputValue>): TaskState {
  const id = String(row.id);
  let data: unknown;
  try {
    data = JSON.parse(String(row.data));
  } catch {
    throw new Error(`storage: invalid task ${JSON.stringify(id)}: data is not JSON`);
  }
  validateTask(data, id);
  // Legacy JSON duplicates may be stale after FK/group changes. Only the SQL columns own these fields.
  const task = {
    ...data,
    id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
    groupId: row.group_id,
    sortKey: row.sort_key,
    projectId: row.project_id,
    parentSessionId: row.parent_task_id ?? undefined,
  };
  validateTask(task, id);
  if (!nonempty(row.id) || !integer(row.revision) || Number(row.revision) < 1)
    throw new Error(`storage: invalid task ${JSON.stringify(id)}: SQL id/revision`);
  delete task.running;
  delete task.pendingQuestion;
  return task;
}
