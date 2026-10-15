import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InputQueue } from "zpi-ui";
import {
  STATE_SCHEMA_VERSION,
  StateStore,
  type TaskState,
  validateStateDatabase,
} from "../src/main/state-store.ts";

const paths: string[] = [];
const stores: StateStore[] = [];
function store(path?: string) {
  const root = mkdtempSync(join(tmpdir(), "zpi-state-"));
  paths.push(root);
  const file = path ?? join(root, "state.sqlite");
  const value = new StateStore(file);
  stores.push(value);
  return { value, file };
}
function task(id = "task"): TaskState {
  return { id, projectId: null, title: "Private title sk-secret", createdAt: 1, updatedAt: 2 };
}
const queue = (): InputQueue => ({
  autoDrain: true,
  items: [
    {
      id: "input",
      text: "private prompt",
      fileReferences: [],
      attachments: [],
      selection: { provider: "p", modelId: "m", reasoning: "off" },
      state: "dispatching",
    },
  ],
});
afterEach(() => {
  for (const item of stores.splice(0)) {
    try {
      item.close();
    } catch {}
  }
  for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
describe("authoritative SQLite state", () => {
  it("lists tasks with one query and the same authoritative column overrides as getTask", () => {
    const { value: s } = store();
    s.upsertProject({ id: "project", name: "Project", path: "/work", updatedAt: 1 });
    s.upsertTask({ ...task("older"), updatedAt: 1 });
    s.upsertTask({ ...task("b"), projectId: "project", parentSessionId: "older", sortKey: 3 });
    s.upsertTask({ ...task("a"), projectId: "project", parentSessionId: "older" });
    s.upsertTask({ ...task("deleted"), updatedAt: 10 });
    s.deleteTask("deleted");
    s.db.exec(`INSERT INTO task_groups(id,title,color,created_at) VALUES ('group','Group','blue',1);
      UPDATE tasks SET group_id='group' WHERE id='b';
      UPDATE tasks SET project_id=NULL,parent_task_id=NULL,sort_key=42,revision=9 WHERE id='a';`);
    const expected = [s.getTask("a"), s.getTask("b"), s.getTask("older")];
    const prepare = vi.spyOn(s.db, "prepare");
    try {
      const listed = s.listTasks();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(listed).toEqual(expected);
      expect(listed.map((item) => item.id)).toEqual(["a", "b", "older"]);
      expect(listed[0]).toMatchObject({
        projectId: null,
        parentSessionId: undefined,
        groupId: null,
        sortKey: 42,
        revision: 9,
      });
      expect(listed[1]).toMatchObject({
        projectId: "project",
        parentSessionId: "older",
        groupId: "group",
        sortKey: 3,
        revision: 1,
      });
    } finally {
      prepare.mockRestore();
    }
  });
  it("reads accepted IDs once while preserving queue order and reserved states", () => {
    const { value: s } = store();
    s.upsertTask(task());
    s.db.prepare("INSERT INTO accepted_inputs VALUES (?,?,?)").run("task", "accepted", "run");
    const input = queue();
    input.items = ["first", "accepted", "last"].map((id) => ({
      ...input.items[0],
      id,
      state: id === "last" ? "dispatching" : "queued",
    }));
    const readAccepted = vi.spyOn(s, "acceptedInputIds");
    s.setQueue("task", input);
    expect(readAccepted).toHaveBeenCalledExactlyOnceWith("task");
    expect(s.getQueue("task")).toEqual({
      ...input,
      items: [input.items[0], input.items[2]],
    });
    expect(s.db.prepare("SELECT id,position,state FROM queue_items ORDER BY position").all()).toEqual([
      { id: "first", position: 0, state: "queued" },
      { id: "last", position: 1, state: "reserved" },
    ]);
    readAccepted.mockClear();
    s.setQueue("task", { autoDrain: true, items: [] });
    expect(readAccepted).not.toHaveBeenCalled();
    expect(s.getQueue("task")).toEqual({ autoDrain: true, items: [] });
  });
  it("reads recovery intents once and reserves only matching task and input pairs", () => {
    const { value: s } = store();
    for (const id of ["task", "other", "empty"]) s.upsertTask(task(id));
    const input = queue();
    input.items = ["prepared", "durable", "blocked", "unreserved"].map((id) => ({
      ...input.items[0],
      id,
    }));
    s.setQueue("task", input);
    s.setQueue("other", { ...queue(), items: [{ ...queue().items[0], id: "other-input" }] });
    s.setQueue("empty", { autoDrain: true, items: [] });
    for (const stage of ["prepared", "durable", "blocked"] as const)
      s.putIntent({
        operationId: stage,
        taskId: "task",
        kind: "accept-input",
        stage,
        targetFile: "task.jsonl",
        queueItemId: stage,
      });
    s.putIntent({
      operationId: "wrong-task",
      taskId: "other",
      kind: "accept-input",
      stage: "prepared",
      targetFile: "other.jsonl",
      queueItemId: "unreserved",
    });
    const readIntents = vi.spyOn(s, "listIntents");
    s.recoverRuntime();
    expect(readIntents).toHaveBeenCalledTimes(1);
    expect(s.getQueue("task")).toEqual({
      ...input,
      autoDrain: false,
      pauseReason: "restart",
      items: input.items.map((item) => ({
        ...item,
        state: item.id === "unreserved" ? "queued" : "dispatching",
      })),
    });
    expect(s.getQueue("other")?.items[0].state).toBe("queued");
    expect(s.getQueue("empty")).toEqual({ autoDrain: true, items: [] });
  });
  it("uses explicit schema, durable WAL and foreign keys", () => {
    const { value: s } = store();
    expect(s.db.prepare("PRAGMA user_version").get()?.user_version).toBe(STATE_SCHEMA_VERSION);
    expect(s.db.prepare("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(s.db.prepare("PRAGMA synchronous").get()?.synchronous).toBe(2);
    expect(s.db.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(() => s.upsertTask({ ...task(), projectId: "missing" })).toThrow();
    expect(s.listTasks()).toEqual([]);
  });
  it("reopens state without a transcript or audit replay", () => {
    const { value: s, file } = store();
    s.upsertProject({ id: "project", name: "Name", path: "/work", updatedAt: 1 });
    s.upsertTask({
      ...task(),
      projectId: "project",
      currentSelection: { provider: "p", modelId: "b", reasoning: "off" },
      running: true,
    });
    s.setSetting("app", { defaultModel: "b" });
    s.saveDraft("task", { revision: 2, text: "draft" } as { revision: number });
    s.saveDraft("task", { revision: 1, text: "stale" } as { revision: number });
    s.db.exec("DELETE FROM operation_log");
    s.checkpoint();
    s.close();
    const reopened = store(file).value;
    expect(reopened.getTask("task")).toMatchObject({
      projectId: "project",
      currentSelection: { modelId: "b" },
    });
    expect(reopened.getTask("task")?.running).toBeUndefined();
    expect(reopened.getSetting("app")).toEqual({ defaultModel: "b" });
    expect(reopened.getDraft("task")).toEqual({ revision: 2, text: "draft" });
  });
  it("atomically rolls state and successful audits back on failure", () => {
    const { value: s } = store();
    s.upsertTask(task());
    expect(() =>
      s.transaction("rename", "task", () => {
        s.upsertTask({ ...task(), title: "changed" });
        s.setSetting("app", { changed: true });
        throw new Error("apiKey=private-secret prompt=private prompt");
      }),
    ).toThrow("private-secret");
    expect(s.getTask("task")?.title).toBe(task().title);
    expect(s.getSetting("app")).toBeUndefined();
    const logs = s.db.prepare("SELECT * FROM operation_log ORDER BY seq").all();
    expect(logs.map((row) => row.outcome)).toEqual(["success", "failure"]);
    expect(JSON.stringify(logs)).not.toMatch(/private-secret|private prompt|Private title|"changed"/);
    expect(logs[0]).toMatchObject({ before_revision: null, after_revision: 1 });
  });
  it("rolls back nested failed work even if the outer transaction catches it", () => {
    const { value: s } = store();
    s.transaction("outer", "task", () => {
      s.upsertTask(task());
      try {
        s.transaction("inner", "task", () => {
          s.setSetting("bad", true);
          throw new Error("fail");
        });
      } catch {}
      s.setSetting("good", true);
    });
    expect(s.getSetting("bad")).toBeUndefined();
    expect(s.getSetting("good")).toBe(true);
  });
  it("stores group membership with stable mixed root ordering", () => {
    const { value: s } = store();
    s.upsertTask(task());
    s.upsertTask(task("two"));
    s.setTaskGroups({
      version: 1,
      groups: [{ id: "group", title: "G", color: "blue", createdAt: 1 }],
      roots: [
        { type: "task", id: "two" },
        { type: "group", id: "group" },
      ],
      members: { group: ["task"] },
    });
    expect(s.getTask("task")).toMatchObject({ groupId: "group", sortKey: 0 });
    expect(s.getTaskGroups().roots).toEqual([
      { type: "task", id: "two" },
      { type: "group", id: "group" },
    ]);
    s.setTaskGroups({
      version: 1,
      groups: [],
      roots: [
        { type: "task", id: "two" },
        { type: "task", id: "task" },
      ],
      members: {},
    });
    expect(s.getTask("task")?.groupId).toBeNull();
    expect(s.getTaskGroups().roots.map((node) => node.id)).toEqual(["two", "task"]);
  });
  it("retains paused queue input and interrupts old runtime ownership without executing", () => {
    const { value: s, file } = store();
    s.upsertTask(task());
    s.setQueue("task", queue());
    s.setRuntime("task", "background", "command", { pid: 1234 });
    s.close();
    const reopened = store(file).value;
    reopened.recoverRuntime();
    expect(reopened.getQueue("task")).toMatchObject({
      autoDrain: false,
      pauseReason: "restart",
      items: [{ id: "input", state: "queued", text: "private prompt" }],
    });
    expect(reopened.listRuntime()[0]).toMatchObject({ status: "interrupted", data: { pid: 1234 } });
    reopened.recoverRuntime();
    expect(reopened.getQueue("task")?.items).toHaveLength(1);
  });
  it("retains recovery intents until final state commits and prevents ID retargeting", () => {
    const { value: s, file } = store();
    s.upsertTask(task());
    const intent = {
      operationId: "op",
      taskId: "task",
      kind: "accept-input" as const,
      stage: "prepared" as const,
      targetFile: "sessions/task.jsonl",
      runId: "run",
      queueItemId: "input",
    };
    s.putIntent(intent);
    s.close();
    const reopened = store(file).value;
    expect(reopened.listIntents()).toEqual([intent]);
    expect(() => reopened.putIntent({ ...intent, targetFile: "other" })).toThrow("identity");
    expect(() =>
      reopened.completeIntent("op", () => {
        reopened.setSetting("test", true);
        throw new Error("crash");
      }),
    ).toThrow();
    expect(reopened.getSetting("test")).toBeUndefined();
    expect(reopened.listIntents()).toHaveLength(1);
    reopened.completeIntent("op", () => reopened.setSetting("test", true));
    expect(reopened.listIntents()).toEqual([]);
  });
  it("accepts queued input once only after a durable fact and atomically finalizes state", () => {
    const { value: s, file } = store();
    s.upsertTask(task());
    s.setQueue("task", queue());
    const intent = {
      operationId: "accept",
      taskId: "task",
      kind: "accept-input" as const,
      stage: "prepared" as const,
      targetFile: "sessions/task.jsonl",
      queueItemId: "input",
      runId: "run",
    };
    s.reserveQueuedInput(intent);
    expect(() => s.completeQueuedInput("accept")).toThrow("durable");
    expect(s.getQueue("task")?.items).toHaveLength(1);
    s.putIntent({ ...intent, stage: "durable", watermark: 123 });
    expect(() =>
      s.completeQueuedInput("accept", () => {
        throw new Error("fault");
      }),
    ).toThrow("fault");
    expect(s.acceptedInputIds("task").size).toBe(0);
    expect(s.getQueue("task")?.items).toHaveLength(1);
    s.completeQueuedInput("accept", () => s.upsertTask({ ...task(), draft: false }));
    expect(s.acceptedInputIds("task")).toEqual(new Set(["input"]));
    expect(s.getQueue("task")?.items).toEqual([]);
    expect(s.listIntents()).toEqual([]);
    s.close();
    const reopened = store(file).value;
    reopened.recoverRuntime();
    expect(reopened.getRuntime("task", "run")[0].status).toBe("interrupted");
    expect(() => reopened.reserveQueuedInput(intent)).toThrow("already accepted");
  });
  it("releases only unaccepted inputs and keeps the queue paused", () => {
    const { value: s } = store();
    s.upsertTask(task());
    s.setQueue("task", queue());
    const intent = {
      operationId: "release",
      taskId: "task",
      kind: "accept-input" as const,
      stage: "prepared" as const,
      targetFile: "task.jsonl",
      queueItemId: "input",
      runId: "run",
    };
    s.reserveQueuedInput(intent);
    s.releaseQueuedInput("release");
    expect(s.getQueue("task")).toMatchObject({ autoDrain: false, items: [{ id: "input", state: "queued" }] });
    expect(s.listIntents()).toEqual([]);
    s.reserveQueuedInput(intent);
    s.putIntent({ ...intent, stage: "durable" });
    expect(() => s.releaseQueuedInput("release")).toThrow("cannot release");
  });
  it("tombstones deleted tasks and does not resurrect them from other state", () => {
    const { value: s } = store();
    s.upsertTask(task());
    s.saveDraft("task", { revision: 1 });
    s.setQueue("task", queue());
    s.deleteTask("task");
    expect(s.getTask("task")).toBeUndefined();
    expect(s.listTasks()).toEqual([]);
    expect(s.getDraft("task")).toBeUndefined();
    expect(s.getQueue("task")).toBeUndefined();
    expect(s.db.prepare("SELECT deleted_at FROM tasks WHERE id='task'").get()?.deleted_at).toBeTypeOf(
      "number",
    );
  });
  it("rejects credentials in public settings", () => {
    const { value: s } = store();
    for (const key of [
      "apiKey",
      "api_key",
      "password",
      "accessToken",
      "refresh_token",
      "authorization",
      "secret",
    ])
      expect(() => s.setSetting("app", { providers: [{ [key]: "secret" }] })).toThrow("encrypted");
    s.setSetting("provider", { credentialRef: "provider-1" });
    expect(s.getSetting("provider")).toEqual({ credentialRef: "provider-1" });
  });
  it("does not serialize extra intent bodies or retain unbounded audit content", () => {
    const { value: s } = store();
    s.upsertTask(task());
    const intent = {
      operationId: "op",
      taskId: "task",
      kind: "create" as const,
      stage: "prepared" as const,
      targetFile: "task.jsonl",
      prompt: "do not persist",
    };
    s.putIntent(intent);
    expect(JSON.stringify(s.listIntents())).not.toContain("do not persist");
    s.pruneAudit(0, 0, 0);
    expect(s.db.prepare("SELECT COUNT(*) AS count FROM operation_log").get()?.count).toBe(1);
    expect(s.getTask("task")?.title).toBe(task().title);
    expect(s.listIntents()).toHaveLength(1);
  });
  it("rolls malformed group moves back without corrupting membership", () => {
    const { value: s } = store();
    s.upsertTask(task());
    expect(() =>
      s.setTaskGroups({
        version: 1,
        groups: [{ id: "g", title: "G", color: "gray", createdAt: 1 }],
        members: { g: ["task"] },
        roots: [
          { type: "group", id: "g" },
          { type: "task", id: "task" },
        ],
      }),
    ).toThrow("duplicate");
    expect(s.getTask("task")?.groupId).toBeNull();
    expect(s.getTaskGroups().groups).toEqual([]);
  });
  it("refuses unknown versions and unversioned databases instead of guessing state", () => {
    const { value: s, file } = store();
    s.db.exec("PRAGMA user_version=999");
    s.close();
    expect(() => new StateStore(file)).toThrow("unsupported schema");
    const root = mkdtempSync(join(tmpdir(), "zpi-unversioned-"));
    paths.push(root);
    const other = join(root, "state.sqlite");
    const db = new DatabaseSync(other);
    db.exec("CREATE TABLE legacy(x TEXT)");
    db.close();
    expect(() => new StateStore(other)).toThrow("offline migration");
  });
});

it("rejects existing empty databases without modifying their bytes", () => {
  const root = mkdtempSync(join(tmpdir(), "zpi-empty-"));
  paths.push(root);
  for (const name of ["zero.sqlite", "empty.sqlite"]) {
    const file = join(root, name);
    if (name === "zero.sqlite") writeFileSync(file, "");
    else new DatabaseSync(file).close();
    const bytes = readFileSync(file);
    expect(() => new StateStore(file)).toThrow("offline migration");
    expect(readFileSync(file)).toEqual(bytes);
  }
});
it.each(["projects", "drafts", "queue_items", "operation_log", "task_runtime"])(
  "rejects a versioned database missing authoritative table %s without repair",
  (table) => {
    const { value: s, file } = store();
    s.db.exec(`DROP TABLE ${table}`);
    s.close();
    const bytes = readFileSync(file);
    expect(() => new StateStore(file)).toThrow("authoritative schema");
    expect(readFileSync(file)).toEqual(bytes);
  },
);
it("keeps unresolved acceptance reserved across restart and prevents durable intent downgrade", () => {
  const { value: s, file } = store();
  s.upsertTask(task());
  s.setQueue("task", queue());
  const intent = {
    operationId: "pending",
    taskId: "task",
    kind: "accept-input" as const,
    stage: "prepared" as const,
    targetFile: "task.jsonl",
    queueItemId: "input",
    runId: "run",
  };
  s.reserveQueuedInput(intent);
  s.putIntent({ ...intent, stage: "durable", watermark: 42 });
  expect(() => s.putIntent({ ...intent, watermark: 42 })).toThrow("cannot be reset");
  expect(() => s.putIntent({ ...intent, stage: "durable", watermark: 43 })).toThrow("watermark");
  s.close();
  const reopened = store(file).value;
  reopened.recoverRuntime();
  expect(reopened.getQueue("task")).toMatchObject({
    autoDrain: false,
    items: [{ id: "input", state: "dispatching" }],
  });
  expect(reopened.listIntents()).toHaveLength(1);
});

it("rolls business changes back if their success audit cannot commit", () => {
  const { value: s } = store();
  s.upsertTask(task());
  s.db.exec(`CREATE TRIGGER reject_success BEFORE INSERT ON operation_log
    WHEN NEW.outcome='success' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
  expect(() => s.upsertTask({ ...task(), title: "changed" })).toThrow("audit unavailable");
  expect(s.getTask("task")?.title).toBe(task().title);
  expect(s.db.prepare("SELECT outcome FROM operation_log ORDER BY seq DESC LIMIT 1").get()?.outcome).toBe(
    "failure",
  );
});
it("explicit full diagnosis rejects foreign-key corruption without repairing authoritative rows", () => {
  const { value: s, file } = store();
  s.db.exec("PRAGMA foreign_keys=OFF");
  s.upsertTask({ ...task(), projectId: "missing" });
  s.close();
  const bytes = readFileSync(file);
  expect(() => validateStateDatabase(file, "full")).toThrow("integrity");
  expect(readFileSync(file)).toEqual(bytes);
});

it("opens with large derived tables without any whole-database integrity scan", () => {
  const { value: s, file } = store();
  s.db.exec(`WITH RECURSIVE rows(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM rows WHERE n<20000)
    INSERT INTO transcript_search SELECT 'large',n,'run',printf('%01024d',n) FROM rows;`);
  s.close();
  const prepare = vi.spyOn(DatabaseSync.prototype, "prepare");
  try {
    const reopened = store(file).value;
    expect(reopened.listTasks()).toEqual([]);
    expect(
      prepare.mock.calls
        .map(([sql]) => sql)
        .filter((sql) =>
          /(?:integrity_check|quick_check|foreign_key_check|FROM transcript_search)/i.test(sql),
        ),
    ).toEqual([]);
  } finally {
    prepare.mockRestore();
  }
});

it("audits renamed, pinned, and archived fields without recording their values", () => {
  const { value: s } = store();
  let current = s.upsertTask(task());
  current = s.upsertTask({ ...current, title: "private renamed title" });
  current = s.upsertTask({ ...current, pinnedAt: 123456 });
  s.upsertTask({ ...current, archivedAt: 654321 });
  const logs = s.db.prepare("SELECT summary FROM operation_log ORDER BY seq").all();
  expect(logs.slice(1).map((row) => JSON.parse(String(row.summary)))).toEqual([
    { changedFields: ["title"] },
    { changedFields: ["pinnedAt"] },
    { changedFields: ["archivedAt"] },
  ]);
  expect(JSON.stringify(logs)).not.toMatch(/private renamed title|123456|654321/);
});
it("audits settings changed field names and rejects credentials without leaking them on failure", () => {
  const { value: s } = store();
  s.setSetting("app", { interface: { theme: "dark" } });
  s.setSetting("app", { interface: { theme: "light" } });
  expect(() =>
    s.setSetting("app", {
      interface: { theme: "light" },
      providers: [{ password: "private-password", apiKey: "private-api-key" }],
    }),
  ).toThrow("encrypted");
  const logs = s.db.prepare("SELECT outcome,summary FROM operation_log ORDER BY seq").all();
  expect(logs.map((row) => ({ outcome: row.outcome, summary: JSON.parse(String(row.summary)) }))).toEqual([
    { outcome: "success", summary: { changedFields: ["interface"] } },
    { outcome: "success", summary: { changedFields: ["interface"] } },
    { outcome: "failure", summary: { changedFields: ["providers"] } },
  ]);
  expect(s.getSetting("app")).toEqual({ interface: { theme: "light" } });
  expect(JSON.stringify(logs)).not.toMatch(/private-password|private-api-key|password|apiKey|light|dark/);
});
it("restricts arbitrary transaction summaries to a bounded fixed field vocabulary", () => {
  const { value: s } = store();
  const summary = {
    changedFields: [
      "title",
      "title",
      "private field name",
      "apiKey",
      "password",
      ...Array(1000).fill("pinnedAt"),
    ],
    prompt: "private prompt",
    password: "private-password",
  };
  expect(() =>
    s.transaction(
      "task.update",
      "task",
      () => {
        throw new Error("private error");
      },
      summary,
    ),
  ).toThrow("private error");
  const log = s.db.prepare("SELECT summary FROM operation_log").get();
  expect(JSON.parse(String(log?.summary))).toEqual({ changedFields: ["pinnedAt", "title"] });
  expect(String(log?.summary).length).toBeLessThan(1024);
});

it.each([
  [null, "data must be an object"],
  [[], "data must be an object"],
  [{}, "id"],
  [{ ...task(), id: "other" }, "id does not match SQL primary key"],
  [{ ...task(), title: undefined }, "title"],
  [{ ...task(), title: 123 }, "title"],
  [{ ...task(), projectId: undefined }, "projectId"],
  [{ ...task(), createdAt: "yesterday" }, "createdAt"],
  [{ ...task(), updatedAt: null }, "updatedAt"],
  [{ ...task(), draft: "false" }, "draft"],
  [{ ...task(), archivedAt: false }, "archivedAt"],
  [{ ...task(), sessionFile: 123 }, "sessionFile"],
  [{ ...task(), worktree: { path: "/work" } }, "worktree"],
  [{ ...task(), currentSelection: {} }, "currentSelection"],
  [{ ...task(), frozenConfiguration: [] }, "frozenConfiguration"],
])("diagnoses invalid task JSON structure without hiding or repairing it: %j", (data, field) => {
  const { value: s } = store();
  s.upsertTask(task());
  s.upsertTask(task("valid"));
  const json = JSON.stringify(data);
  s.db.prepare("UPDATE tasks SET data=? WHERE id='task'").run(json);
  for (const read of [() => s.getTask("task"), () => s.listTasks()]) {
    expect(read).toThrow(`storage: invalid task "task": ${field}`);
  }
  expect(s.db.prepare("SELECT data FROM tasks WHERE id='task'").get()?.data).toBe(json);
  expect(s.getTask("valid")?.id).toBe("valid");
});
it("reads authoritative SQL identity, title, dates and membership over typed legacy JSON mirrors", () => {
  const { value: s } = store();
  s.upsertTask(task());
  s.db.exec(
    "UPDATE tasks SET title='SQL title',created_at=100,updated_at=200,revision=8,sort_key=9 WHERE id='task'",
  );
  expect(s.getTask("task")).toMatchObject({
    id: "task",
    title: "SQL title",
    createdAt: 100,
    updatedAt: 200,
    revision: 8,
    sortKey: 9,
  });
  s.db.exec("UPDATE tasks SET updated_at='invalid' WHERE id='task'");
  expect(() => s.listTasks()).toThrow("updatedAt");
});
it("increments task revisions only for changed persisted task fields, including group/root moves", () => {
  const { value: s } = store();
  s.upsertTask(task());
  s.upsertTask(task("two"));
  const version = () => s.getTask("task")?.revision;
  expect(s.upsertTask(task()).revision).toBe(1);
  expect(s.upsertTask({ ...task(), running: true }).revision).toBe(1);
  expect(s.upsertTask({ ...task(), pinnedAt: undefined, parentSessionId: undefined }).revision).toBe(1);
  const grouped = {
    version: 1 as const,
    groups: [{ id: "g", title: "G", color: "blue" as const, createdAt: 1 }],
    roots: [
      { type: "group" as const, id: "g" },
      { type: "task" as const, id: "two" },
    ],
    members: { g: ["task"] },
  };
  s.setTaskGroups(grouped);
  expect(version()).toBe(2);
  s.setTaskGroups(grouped);
  expect(version()).toBe(2);
  s.setTaskGroups({ ...grouped, groups: [{ ...grouped.groups[0], title: "Renamed" }] });
  expect(version()).toBe(2); // The group title is not a task field.
  const ungrouped = {
    version: 1 as const,
    groups: [],
    members: {},
    roots: [
      { type: "task" as const, id: "task" },
      { type: "task" as const, id: "two" },
    ],
  };
  s.setTaskGroups(ungrouped);
  expect(version()).toBe(3); // Move out even with the same sort key.
  s.setTaskGroups({ ...ungrouped, roots: [...ungrouped.roots].reverse() });
  expect(version()).toBe(4);
  s.setTaskGroups({ ...ungrouped, roots: [...ungrouped.roots].reverse() });
  expect(version()).toBe(4);
  const current = s.getTask("task");
  if (!current) throw new Error("missing task fixture");
  s.upsertTask({ ...current, archivedAt: 100 });
  expect(version()).toBe(5);
  s.deleteTask("task");
  const deletedRevision = s.db.prepare("SELECT revision FROM tasks WHERE id='task'").get()?.revision;
  expect(deletedRevision).toBe(6);
  s.deleteTask("task");
  expect(s.db.prepare("SELECT revision FROM tasks WHERE id='task'").get()?.revision).toBe(6);
  expect(() => s.upsertTask(task())).toThrow("cannot resurrect");
});
it("bumps task revisions when a project is deleted, including archived tasks, without touching unrelated tasks", () => {
  const { value: s } = store();
  s.upsertProject({ id: "p", name: "Project", path: "/work", updatedAt: 1 });
  s.upsertTask({ ...task(), projectId: "p" });
  s.upsertTask({ ...task("archived"), projectId: "p", archivedAt: 1 });
  s.upsertTask(task("unrelated"));
  s.deleteProject("p");
  s.deleteProject("p");
  for (const id of ["task", "archived"])
    expect(s.getTask(id)).toMatchObject({ projectId: null, revision: 2 });
  expect(s.getTask("unrelated")?.revision).toBe(1);
});
