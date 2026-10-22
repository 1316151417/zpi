import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import type { ModelPerformanceTotals } from "zpi-coding-agent";
import type { InputQueue, SessionControls } from "zpi-ui";
import type { CombinedSelection, ProjectRecord, SessionRecord } from "../shared/bridge.ts";
import { emptyTaskGroups, type TaskGroupState, taskGroupColors } from "../shared/task-groups.ts";
import { migrateStateDatabase, validateStateDatabase } from "./state-migrations.ts";
import { taskFromRow, validateTask } from "./task-state.ts";

export { STATE_SCHEMA_VERSION, validateStateDatabase } from "./state-migrations.ts";
export interface TaskState extends SessionRecord {
  modelPerformanceTotals?: ModelPerformanceTotals;
  sideChatInheritance?: {
    version: 1;
    childGeneration: string;
    parentGeneration?: string;
    parentEndSeq?: number;
    hiddenEndSeq: number;
    totals: ModelPerformanceTotals;
  };
  titleState?: string;
  lastThinkingLevel?: SessionControls["lastThinkingLevel"];
  fork?: { sessionId: string; runId: string };
  sessionFile?: string;
  currentSelection?: CombinedSelection;
  frozenConfiguration?: unknown;
  groupId?: string | null;
  sortKey?: number;
  queuePaused?: boolean;
  /** Version of persisted task fields (including SQL ownership/order and deletion); excludes runtime/queue/drafts. */
  revision?: number;
}
export interface StorageIntent {
  operationId: string;
  taskId: string;
  kind: "create" | "accept-input" | "replace" | "fork";
  stage: "prepared" | "durable" | "blocked";
  targetFile: string;
  resultFile?: string;
  runId?: string;
  queueItemId?: string;
  generation?: string;
  watermark?: number;
}
export interface RuntimeState<T = unknown> {
  taskId: string;
  kind: string;
  instanceId: string;
  ownerEpoch: string;
  status: string;
  data: T;
}
function encode(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("storage: undefined JSON state");
  return json;
}
function noSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      /^(api[_-]?key|password|secret|client[_-]?secret|access[_-]?token|refresh[_-]?token|authorization)$/i.test(
        key,
      )
    )
      throw new Error("storage: credentials must stay in encrypted credential storage");
    noSecrets(child);
  }
}
function auditLabel(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.:/-]/g, "_").slice(0, 120);
}
// Fixed vocabulary only: arbitrary object keys can themselves contain private content.
const taskAuditFields = [
  "projectId",
  "parentSessionId",
  "newWorktree",
  "worktreeBaseRef",
  "worktree",
  "draft",
  "cwd",
  "pinnedAt",
  "archivedAt",
  "unreadAt",
  "diagnostic",
  "title",
  "status",
  "activitySeq",
  "createdAt",
  "updatedAt",
  "titleState",
  "lastThinkingLevel",
  "fork",
  "sessionFile",
  "currentSelection",
  "frozenConfiguration",
  "groupId",
  "sortKey",
  "queuePaused",
  "modelPerformanceTotals",
  "sideChatInheritance",
] as const;
const settingsAuditFields = [
  "shortcuts",
  "shortcutDefaultsVersion",
  "capabilities",
  "version",
  "templates",
  "selectedTemplateId",
  "disabledSkillPaths",
  "providers",
  "lastSelection",
  "interface",
] as const;
const auditFields = new Set<string>([...taskAuditFields, ...settingsAuditFields, "value"]);
export interface AuditSummary {
  changedFields: readonly string[];
}
function safeAuditSummary(summary?: AuditSummary): string {
  const fields = Array.isArray(summary?.changedFields) ? summary.changedFields : [];
  return JSON.stringify({
    changedFields: [...new Set(fields.filter((field) => auditFields.has(field)))].sort(),
  });
}
function changedFields(before: unknown, after: unknown, fields: readonly string[]): string[] {
  const old = before as Record<string, unknown> | undefined;
  const next = after as Record<string, unknown> | undefined;
  return fields.filter((field) => !isDeepStrictEqual(old?.[field], next?.[field]));
}
/** Authoritative desktop state. Transcript projections may share db, never rebuild these tables. */
export class StateStore {
  readonly db: DatabaseSync;
  readonly ownerEpoch = randomUUID();
  private transactionDepth = 0;
  private savepoint = 0;
  private closed = false;
  constructor(path: string) {
    if (path !== ":memory:" && existsSync(path)) validateStateDatabase(path);
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    try {
      this.db.exec(
        "PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;",
      );
      migrateStateDatabase(this.db);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }
  transaction<T>(action: string, entityId: string, work: () => T, summary?: AuditSummary): T {
    const outer = this.transactionDepth === 0;
    const point = `state_${++this.savepoint}`;
    this.db.exec(outer ? "BEGIN IMMEDIATE" : `SAVEPOINT ${point}`);
    this.transactionDepth++;
    let beforeRevision: unknown;
    try {
      beforeRevision = this.db.prepare("SELECT revision FROM tasks WHERE id=?").get(entityId)?.revision;
      const result = work();
      if (result && typeof (result as { then?: unknown }).then === "function")
        throw new Error("storage: transactions must be synchronous");
      this.audit(
        action,
        entityId,
        "success",
        beforeRevision == null ? null : Number(beforeRevision),
        summary,
      );
      this.db.exec(outer ? "COMMIT" : `RELEASE ${point}`);
      return result;
    } catch (error) {
      this.db.exec(outer ? "ROLLBACK" : `ROLLBACK TO ${point}; RELEASE ${point}`);
      // Error messages can contain prompts, paths, or tokens. Never copy them into audit.
      this.audit(
        action,
        entityId,
        "failure",
        beforeRevision == null ? null : Number(beforeRevision),
        summary,
      );
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  private audit(
    action: string,
    entityId: string,
    outcome: "success" | "failure",
    beforeRevision: number | null,
    summary?: AuditSummary,
  ): void {
    const afterRevision = this.db.prepare("SELECT revision FROM tasks WHERE id=?").get(entityId)?.revision;
    this.db
      .prepare(
        "INSERT INTO operation_log(operation_id,entity_id,action,outcome,created_at,summary,before_revision,after_revision) VALUES (?,?,?,?,?,?,?,?)",
      )
      .run(
        randomUUID(),
        auditLabel(entityId),
        auditLabel(action),
        outcome,
        Date.now(),
        safeAuditSummary(summary),
        beforeRevision,
        afterRevision == null ? null : Number(afterRevision),
      );
  }
  pruneAudit(before = Date.now() - 30 * 86400_000, maxRows = 100_000, maxBytes = 100 * 1024 * 1024): void {
    if (!Number.isSafeInteger(maxRows) || maxRows < 0 || !Number.isSafeInteger(maxBytes) || maxBytes < 0)
      throw new Error("storage: invalid audit retention");
    this.transaction("audit.prune", "operation_log", () => {
      this.db.prepare("DELETE FROM operation_log WHERE created_at < ?").run(before);
      this.db
        .prepare(
          "DELETE FROM operation_log WHERE seq NOT IN (SELECT seq FROM operation_log ORDER BY seq DESC LIMIT ?)",
        )
        .run(maxRows);
      this.db
        .prepare(`DELETE FROM operation_log WHERE seq IN (
        SELECT seq FROM (SELECT seq, SUM(length(CAST(entity_id AS BLOB))+length(CAST(action AS BLOB))+
        length(CAST(summary AS BLOB))+length(operation_id)+64) OVER (ORDER BY seq DESC) AS bytes
        FROM operation_log) WHERE bytes > ?)`)
        .run(maxBytes);
    });
  }
  getTask(id: string): TaskState | undefined {
    const row = this.db.prepare("SELECT * FROM tasks WHERE id=? AND deleted_at IS NULL").get(id);
    return row ? taskFromRow(row) : undefined;
  }
  listTasks(): TaskState[] {
    return this.db
      .prepare("SELECT * FROM tasks WHERE deleted_at IS NULL ORDER BY updated_at DESC,id")
      .all()
      .map(taskFromRow);
  }
  upsertTask(value: TaskState): TaskState {
    const summary: AuditSummary = { changedFields: [] };
    return this.transaction(
      "task.upsert",
      value.id,
      () => {
        const previous = this.getTask(value.id);
        if (!previous && this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(value.id))
          throw new Error("storage: cannot resurrect a deleted task");
        const next = {
          ...previous,
          ...value,
          groupId: value.groupId === undefined ? (previous?.groupId ?? null) : value.groupId,
          sortKey: value.sortKey === undefined ? (previous?.sortKey ?? 0) : value.sortKey,
        };
        // Live ownership and pending UI requests cannot survive process restart.
        delete next.running;
        delete next.pendingQuestion;
        delete next.revision;
        validateTask(next, value.id);
        summary.changedFields = changedFields(previous, next, taskAuditFields);
        const { revision: _revision, ...before } = previous ?? {};
        const json = encode(next);
        if (previous && isDeepStrictEqual(JSON.parse(encode(before)), JSON.parse(json))) return previous;
        const revision = (previous?.revision ?? 0) + 1;
        this.db
          .prepare(`INSERT INTO tasks(id,project_id,parent_task_id,group_id,sort_key,title,created_at,updated_at,revision,data)
        VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET project_id=excluded.project_id,
        parent_task_id=excluded.parent_task_id,group_id=excluded.group_id,sort_key=excluded.sort_key,title=excluded.title,
        created_at=excluded.created_at,updated_at=excluded.updated_at,revision=excluded.revision,data=excluded.data`)
          .run(
            next.id,
            next.projectId,
            next.parentSessionId ?? null,
            next.groupId ?? null,
            next.sortKey ?? 0,
            next.title,
            next.createdAt,
            next.updatedAt,
            revision,
            json,
          );
        const saved = this.getTask(value.id);
        if (!saved) throw new Error("storage: task write missing");
        return saved;
      },
      summary,
    );
  }
  deleteTask(id: string): void {
    this.transaction("task.delete", id, () => {
      if (!this.getTask(id)) return;
      this.enqueueCleanup("task", id);
      for (const intent of this.listIntents().filter((intent) => intent.taskId === id)) {
        this.enqueueCleanup("transcript", id, intent.targetFile);
        if (intent.resultFile) this.enqueueCleanup("transcript", id, intent.resultFile);
      }
      this.db.prepare("UPDATE tasks SET deleted_at=?,revision=revision+1 WHERE id=?").run(Date.now(), id);
      for (const table of [
        "drafts",
        "queue_items",
        "queue_state",
        "task_runtime",
        "accepted_inputs",
        "storage_operations",
      ])
        this.db.prepare(`DELETE FROM ${table} WHERE task_id=?`).run(id);
    });
  }
  enqueueCleanup(kind: "task" | "transcript", taskId: string, path = ""): void {
    this.db
      .prepare("INSERT OR IGNORE INTO storage_cleanup(kind,task_id,path) VALUES (?,?,?)")
      .run(kind, taskId, path);
  }
  pendingCleanup(): { kind: "task" | "transcript"; taskId: string; path: string }[] {
    return this.db
      .prepare("SELECT kind,task_id,path FROM storage_cleanup ORDER BY kind,task_id,path")
      .all()
      .map((row) => ({
        kind: row.kind as "task" | "transcript",
        taskId: String(row.task_id),
        path: String(row.path),
      }));
  }
  upsertProject(value: ProjectRecord): void {
    this.transaction("project.upsert", value.id, () => {
      this.db
        .prepare(`INSERT INTO projects(id,name,path,hidden,updated_at,data,sort_key)
        VALUES (?,?,?,?,?,?,(SELECT COALESCE(MAX(sort_key),-1)+1 FROM projects))
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,path=excluded.path,hidden=excluded.hidden,
        updated_at=excluded.updated_at,data=excluded.data,revision=projects.revision+1`)
        .run(value.id, value.name, value.path, Number(Boolean(value.hidden)), value.updatedAt, encode(value));
    });
  }
  listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT data FROM projects ORDER BY sort_key,id")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  setProjects(values: readonly ProjectRecord[]): void {
    this.transaction("projects.replace", "projects", () => {
      const keep = new Set(values.map((value) => value.id));
      for (const row of this.db.prepare("SELECT id FROM projects").all())
        if (!keep.has(String(row.id))) this.deleteProject(String(row.id));
      for (const [sort, value] of values.entries()) {
        this.upsertProject(value);
        this.db.prepare("UPDATE projects SET sort_key=? WHERE id=?").run(sort, value.id);
      }
    });
  }
  deleteProject(id: string): void {
    this.transaction("project.delete", id, () => {
      this.db.prepare("UPDATE tasks SET project_id=NULL,revision=revision+1 WHERE project_id=?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id=?").run(id);
    });
  }
  getSetting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM app_settings WHERE key=?").get(key);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  setSetting(key: string, value: unknown): void {
    const summary: AuditSummary = { changedFields: [] };
    this.transaction(
      "settings.update",
      key,
      () => {
        const previous = this.getSetting(key);
        summary.changedFields = changedFields(previous, value, settingsAuditFields);
        if (!summary.changedFields.length && !isDeepStrictEqual(previous, value))
          summary.changedFields = ["value"];
        noSecrets(value);
        this.db
          .prepare(`INSERT INTO app_settings(key,data) VALUES (?,?) ON CONFLICT(key)
        DO UPDATE SET data=excluded.data,revision=app_settings.revision+1`)
          .run(key, encode(value));
      },
      summary,
    );
  }
  getDraft<T>(taskId: string): T | undefined {
    const row = this.db.prepare("SELECT data FROM drafts WHERE task_id=?").get(taskId);
    return row ? JSON.parse(String(row.data)) : undefined;
  }
  saveDraft(taskId: string, value: { revision: number }): void {
    if (!Number.isSafeInteger(value.revision) || value.revision < 0)
      throw new Error("storage: invalid draft revision");
    this.transaction("draft.save", taskId, () => {
      this.db
        .prepare(`INSERT INTO drafts(task_id,revision,data) VALUES (?,?,?) ON CONFLICT(task_id)
        DO UPDATE SET revision=excluded.revision,data=excluded.data WHERE excluded.revision >= drafts.revision`)
        .run(taskId, value.revision, encode(value));
    });
  }
  deleteDraft(taskId: string): void {
    this.transaction("draft.delete", taskId, () => {
      this.db.prepare("DELETE FROM drafts WHERE task_id=?").run(taskId);
    });
  }
  getTaskGroups(): TaskGroupState {
    const state = emptyTaskGroups();
    const roots: { type: "group" | "task"; id: string; sort: number }[] = [];
    for (const row of this.db.prepare("SELECT * FROM task_groups ORDER BY sort_key,id").all()) {
      const id = String(row.id);
      state.groups.push({
        id,
        title: String(row.title),
        color: row.color as TaskGroupState["groups"][number]["color"],
        createdAt: Number(row.created_at),
      });
      state.members[id] = [];
      roots.push({ type: "group", id, sort: Number(row.sort_key) });
    }
    for (const row of this.db
      .prepare(
        "SELECT id,group_id,sort_key FROM tasks WHERE deleted_at IS NULL AND parent_task_id IS NULL ORDER BY sort_key,id",
      )
      .all()) {
      if (row.group_id !== null) state.members[String(row.group_id)]?.push(String(row.id));
      else roots.push({ type: "task", id: String(row.id), sort: Number(row.sort_key) });
    }
    state.roots = roots
      .sort((a, b) => a.sort - b.sort || a.id.localeCompare(b.id))
      .map(({ type, id }) => ({ type, id }));
    return state;
  }
  setTaskGroups(state: TaskGroupState): void {
    this.transaction("groups.update", "groups", () => {
      if (state.version !== 1) throw new Error("storage: invalid group version");
      const groupIds = new Set<string>();
      const taskIds = new Set<string>();
      const rootGroups = new Set<string>();
      const includeTask = (id: string) => {
        const task = this.getTask(id);
        if (!task || task.parentSessionId || taskIds.has(id))
          throw new Error("storage: invalid or duplicate grouped task");
        taskIds.add(id);
      };
      for (const group of state.groups) {
        if (!group.id || groupIds.has(group.id) || !taskGroupColors.includes(group.color))
          throw new Error("storage: invalid or duplicate group");
        groupIds.add(group.id);
        for (const id of state.members[group.id] ?? []) includeTask(id);
      }
      for (const node of state.roots) {
        if (node.type === "task") includeTask(node.id);
        else {
          if (!groupIds.has(node.id) || rootGroups.has(node.id))
            throw new Error("storage: invalid group root");
          rootGroups.add(node.id);
        }
      }
      if (rootGroups.size !== groupIds.size) throw new Error("storage: missing group root");
      // Apply final values once. Removing a group and moving its tasks is one task revision change.
      const placements = new Map<string, { group: string | null; sort: number }>();
      for (const group of state.groups) {
        this.db
          .prepare(`INSERT INTO task_groups(id,title,color,created_at) VALUES (?,?,?,?) ON CONFLICT(id)
          DO UPDATE SET title=excluded.title,color=excluded.color,revision=task_groups.revision+1
          WHERE task_groups.title IS NOT excluded.title OR task_groups.color IS NOT excluded.color`)
          .run(group.id, group.title, group.color, group.createdAt);
        for (const [sort, id] of (state.members[group.id] ?? []).entries())
          placements.set(id, { group: group.id, sort });
      }
      for (const [sort, node] of state.roots.entries()) {
        if (node.type === "task") placements.set(node.id, { group: null, sort });
        else
          this.db
            .prepare("UPDATE task_groups SET sort_key=?,revision=revision+1 WHERE id=? AND sort_key IS NOT ?")
            .run(sort, node.id, sort);
      }
      for (const row of this.db
        .prepare("SELECT id,group_id,sort_key FROM tasks WHERE deleted_at IS NULL")
        .all()) {
        const placement = placements.get(String(row.id)) ?? { group: null, sort: row.sort_key };
        this.db
          .prepare(`UPDATE tasks SET group_id=?,sort_key=?,revision=revision+1
          WHERE id=? AND (group_id IS NOT ? OR sort_key IS NOT ?)`)
          .run(placement.group, placement.sort, row.id, placement.group, placement.sort);
      }
      for (const row of this.db.prepare("SELECT id FROM task_groups").all()) {
        if (groupIds.has(String(row.id))) continue;
        // Tombstones can still reference a removed group; retain their revision semantics too.
        this.db.prepare("UPDATE tasks SET group_id=NULL,revision=revision+1 WHERE group_id=?").run(row.id);
        this.db.prepare("DELETE FROM task_groups WHERE id=?").run(row.id);
      }
    });
  }
  getQueue(taskId: string): InputQueue | undefined {
    const state = this.db.prepare("SELECT data FROM queue_state WHERE task_id=?").get(taskId);
    if (!state) return undefined;
    return {
      ...JSON.parse(String(state.data)),
      items: this.db
        .prepare("SELECT data FROM queue_items WHERE task_id=? ORDER BY position")
        .all(taskId)
        .map((row) => JSON.parse(String(row.data))),
    };
  }
  setQueue(taskId: string, value: InputQueue): void {
    this.transaction("queue.update", taskId, () => {
      const { items, ...state } = value;
      this.db
        .prepare(
          "INSERT INTO queue_state(task_id,data) VALUES (?,?) ON CONFLICT(task_id) DO UPDATE SET data=excluded.data",
        )
        .run(taskId, encode(state));
      this.db.prepare("DELETE FROM queue_items WHERE task_id=?").run(taskId);
      if (!items.length) return;
      const acceptedIds = this.acceptedInputIds(taskId);
      for (const [position, item] of items.filter((item) => !acceptedIds.has(item.id)).entries())
        this.db
          .prepare("INSERT INTO queue_items(id,task_id,position,state,data) VALUES (?,?,?,?,?)")
          .run(item.id, taskId, position, item.state === "dispatching" ? "reserved" : "queued", encode(item));
    });
  }
  getRuntime<T = unknown>(taskId: string, kind?: string): RuntimeState<T>[] {
    const rows =
      kind === undefined
        ? this.db.prepare("SELECT * FROM task_runtime WHERE task_id=?").all(taskId)
        : this.db.prepare("SELECT * FROM task_runtime WHERE task_id=? AND kind=?").all(taskId, kind);
    return rows.map((row) => ({
      taskId,
      kind: String(row.kind),
      instanceId: String(row.instance_id),
      ownerEpoch: String(row.owner_epoch),
      status: String(row.status),
      data: JSON.parse(String(row.data)),
    }));
  }
  listRuntime<T = unknown>(taskId?: string, kind?: string): RuntimeState<T>[] {
    if (taskId !== undefined) return this.getRuntime<T>(taskId, kind);
    const rows =
      kind === undefined
        ? this.db.prepare("SELECT DISTINCT task_id FROM task_runtime").all()
        : this.db.prepare("SELECT DISTINCT task_id FROM task_runtime WHERE kind=?").all(kind);
    return rows.flatMap((row) => this.getRuntime<T>(String(row.task_id), kind));
  }
  setRuntime(taskId: string, kind: string, instanceId: string, data: unknown, status = "running"): void {
    this.transaction("runtime.update", taskId, () => {
      this.db
        .prepare(`INSERT INTO task_runtime(task_id,kind,instance_id,owner_epoch,status,data) VALUES (?,?,?,?,?,?)
        ON CONFLICT(task_id,kind,instance_id) DO UPDATE SET owner_epoch=excluded.owner_epoch,status=excluded.status,data=excluded.data`)
        .run(taskId, kind, instanceId, this.ownerEpoch, status, encode(data));
    });
  }
  recoverRuntime(): void {
    this.transaction("runtime.recover", "runtime", () => {
      this.db
        .prepare(
          "UPDATE task_runtime SET status='interrupted' WHERE status IN ('running','pending','starting','accepted') AND owner_epoch<>?",
        )
        .run(this.ownerEpoch);
      const reservedInputs = new Map<string, Set<string>>();
      for (const intent of this.listIntents()) {
        if (intent.queueItemId === undefined) continue;
        const ids = reservedInputs.get(intent.taskId) ?? new Set<string>();
        ids.add(intent.queueItemId);
        reservedInputs.set(intent.taskId, ids);
      }
      for (const row of this.db.prepare("SELECT task_id FROM queue_state").all()) {
        const id = String(row.task_id),
          queue = this.getQueue(id);
        if (queue?.items.length)
          this.setQueue(id, {
            ...queue,
            autoDrain: false,
            pauseReason: "restart",
            items: queue.items.map((item) => ({
              ...item,
              state: reservedInputs.get(id)?.has(item.id) ? "dispatching" : "queued",
            })),
          });
      }
    });
  }
  reserveQueuedInput(intent: StorageIntent): void {
    if (intent.kind !== "accept-input" || intent.stage !== "prepared" || !intent.queueItemId || !intent.runId)
      throw new Error("storage: invalid input acceptance intent");
    const { queueItemId, runId } = intent;
    this.transaction("queue.reserve", intent.taskId, () => {
      if (
        this.db
          .prepare("SELECT 1 FROM accepted_inputs WHERE task_id=? AND queue_item_id=?")
          .get(intent.taskId, queueItemId)
      )
        throw new Error("storage: input already accepted");
      const row = this.db
        .prepare("SELECT data,state FROM queue_items WHERE task_id=? AND id=?")
        .get(intent.taskId, queueItemId);
      if (!row) throw new Error("storage: queued input missing");
      const pending = this.listIntents().find(
        (item) => item.taskId === intent.taskId && item.queueItemId === intent.queueItemId,
      );
      if (pending && pending.operationId !== intent.operationId)
        throw new Error("storage: input already reserved");
      this.putIntent(intent);
      const data = { ...JSON.parse(String(row.data)), state: "dispatching" };
      this.db
        .prepare("UPDATE queue_items SET state='reserved',accepted_run_id=?,data=? WHERE task_id=? AND id=?")
        .run(runId, encode(data), intent.taskId, queueItemId);
    });
  }
  completeQueuedInput(operationId: string, finalize: () => void = () => {}): void {
    const intent = this.listIntents().find((item) => item.operationId === operationId);
    if (intent?.kind !== "accept-input" || intent.stage !== "durable" || !intent.queueItemId || !intent.runId)
      throw new Error("storage: input acceptance requires a durable transcript commit");
    this.completeIntent(operationId, () => {
      this.db
        .prepare("INSERT INTO accepted_inputs(task_id,queue_item_id,run_id) VALUES (?,?,?)")
        .run(intent.taskId, intent.queueItemId as string, intent.runId as string);
      this.db
        .prepare("DELETE FROM queue_items WHERE task_id=? AND id=?")
        .run(intent.taskId, intent.queueItemId as string);
      this.setRuntime(
        intent.taskId,
        "run",
        intent.runId as string,
        { queueItemId: intent.queueItemId },
        "accepted",
      );
      finalize();
    });
  }
  acceptedInputIds(taskId: string): Set<string> {
    return new Set(
      this.db
        .prepare("SELECT queue_item_id FROM accepted_inputs WHERE task_id=?")
        .all(taskId)
        .map((row) => String(row.queue_item_id)),
    );
  }
  putIntent(input: StorageIntent): void {
    // Keep this recovery journal small: never serialize an accidental prompt or tool-output property.
    const {
      operationId,
      taskId,
      kind,
      stage,
      targetFile,
      resultFile,
      runId,
      queueItemId,
      generation,
      watermark,
    } = input;
    const intent: StorageIntent = {
      operationId,
      taskId,
      kind,
      stage,
      targetFile,
      resultFile,
      runId,
      queueItemId,
      generation,
      watermark,
    };
    if (
      !["create", "accept-input", "replace", "fork"].includes(intent.kind) ||
      !["prepared", "durable", "blocked"].includes(intent.stage) ||
      [intent.operationId, intent.taskId, intent.runId, intent.queueItemId, intent.generation].some(
        (value) => value !== undefined && (typeof value !== "string" || value.length > 256),
      ) ||
      typeof intent.targetFile !== "string" ||
      intent.targetFile.length > 4096 ||
      (intent.resultFile !== undefined &&
        (typeof intent.resultFile !== "string" || !intent.resultFile || intent.resultFile.length > 4096)) ||
      !intent.operationId ||
      !intent.taskId ||
      !intent.targetFile ||
      (intent.watermark !== undefined && (!Number.isSafeInteger(intent.watermark) || intent.watermark < 0))
    )
      throw new Error("storage: invalid recovery intent");
    this.transaction("intent.prepare", intent.taskId, () => {
      const existing = this.db
        .prepare("SELECT data FROM storage_operations WHERE operation_id=?")
        .get(intent.operationId);
      if (existing) {
        const old: StorageIntent = JSON.parse(String(existing.data));
        if (
          old.taskId !== intent.taskId ||
          old.kind !== intent.kind ||
          old.targetFile !== intent.targetFile ||
          old.runId !== intent.runId ||
          old.queueItemId !== intent.queueItemId ||
          old.generation !== intent.generation
        )
          throw new Error("storage: recovery intent identity cannot change");
        if (old.stage === "durable" && intent.stage === "prepared")
          throw new Error("storage: durable recovery intent cannot be reset");
        if (old.resultFile !== undefined && old.resultFile !== intent.resultFile)
          throw new Error("storage: recovery result file cannot change");
        if (old.watermark !== undefined && old.watermark !== intent.watermark)
          throw new Error("storage: recovery intent watermark cannot change");
      }
      this.db
        .prepare(`INSERT INTO storage_operations(operation_id,task_id,kind,stage,data) VALUES (?,?,?,?,?)
        ON CONFLICT(operation_id) DO UPDATE SET stage=excluded.stage,data=excluded.data`)
        .run(intent.operationId, intent.taskId, intent.kind, intent.stage, encode(intent));
    });
  }
  listIntents(): StorageIntent[] {
    return this.db
      .prepare("SELECT data FROM storage_operations ORDER BY operation_id")
      .all()
      .map((row) => JSON.parse(String(row.data)));
  }
  completeIntent(operationId: string, finalize: () => void = () => {}): void {
    this.transaction("intent.complete", operationId, () => {
      if (!this.db.prepare("SELECT 1 FROM storage_operations WHERE operation_id=?").get(operationId))
        throw new Error("storage: missing recovery intent");
      finalize();
      this.db.prepare("DELETE FROM storage_operations WHERE operation_id=?").run(operationId);
    });
  }
}
