// Released schema v1. Frozen: add new migrations instead of editing this definition.
export const stateSchemaV1 = `
CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, path TEXT NOT NULL,
 hidden INTEGER NOT NULL DEFAULT 0, sort_key REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE task_groups(id TEXT PRIMARY KEY, title TEXT NOT NULL, color TEXT NOT NULL,
 created_at INTEGER NOT NULL, sort_key REAL NOT NULL DEFAULT 0, revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
 parent_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL, group_id TEXT REFERENCES task_groups(id) ON DELETE SET NULL,
 sort_key REAL NOT NULL DEFAULT 0, title TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1, deleted_at INTEGER, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE INDEX tasks_project ON tasks(project_id, updated_at);
CREATE INDEX tasks_group ON tasks(group_id,sort_key);
CREATE TABLE app_settings(key TEXT PRIMARY KEY, data TEXT NOT NULL CHECK(json_valid(data)), revision INTEGER NOT NULL DEFAULT 1);
CREATE TABLE drafts(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE queue_state(task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE queue_items(id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 position INTEGER NOT NULL, state TEXT NOT NULL CHECK(state IN ('queued','reserved')), accepted_run_id TEXT,
 data TEXT NOT NULL CHECK(json_valid(data)), UNIQUE(task_id,position));
CREATE TABLE accepted_inputs(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 queue_item_id TEXT NOT NULL, run_id TEXT NOT NULL, PRIMARY KEY(task_id,queue_item_id), UNIQUE(task_id,run_id));
CREATE TABLE task_runtime(task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, kind TEXT NOT NULL,
 instance_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)),
 PRIMARY KEY(task_id,kind,instance_id));
CREATE TABLE storage_operations(operation_id TEXT PRIMARY KEY, task_id TEXT NOT NULL,
 kind TEXT NOT NULL, stage TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)));
CREATE TABLE operation_log(seq INTEGER PRIMARY KEY AUTOINCREMENT, operation_id TEXT NOT NULL,
 entity_id TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL CHECK(outcome IN ('success','failure')),
 created_at INTEGER NOT NULL, before_revision INTEGER, after_revision INTEGER,
 summary TEXT NOT NULL CHECK(length(summary)<=1024));
CREATE INDEX operation_log_time ON operation_log(created_at);
`;
