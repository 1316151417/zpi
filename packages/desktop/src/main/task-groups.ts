import { randomUUID } from "node:crypto";
import type { SessionRecord } from "../shared/bridge.ts";
import {
  applyTaskGroupCommand,
  emptyTaskGroups,
  reconcileTaskGroups,
  type TaskGroupCommand,
  type TaskGroupNode,
  type TaskGroupState,
  taskGroupColors,
} from "../shared/task-groups.ts";
import type { StateStore } from "./state-store.ts";

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function node(value: unknown): value is TaskGroupNode {
  return (
    object(value) &&
    (value.type === "group" || value.type === "task") &&
    typeof value.id === "string" &&
    value.id.length > 0
  );
}
function validState(value: unknown): value is TaskGroupState {
  return (
    object(value) &&
    value.version === 1 &&
    Array.isArray(value.groups) &&
    value.groups.every(
      (group) =>
        object(group) &&
        typeof group.id === "string" &&
        group.id.length > 0 &&
        typeof group.title === "string" &&
        typeof group.createdAt === "number" &&
        Number.isFinite(group.createdAt) &&
        taskGroupColors.includes(group.color as never),
    ) &&
    new Set(value.groups.map((group) => group.id)).size === value.groups.length &&
    Array.isArray(value.roots) &&
    value.roots.every(node) &&
    object(value.members) &&
    Object.values(value.members).every(
      (ids) => Array.isArray(ids) && ids.every((id) => typeof id === "string"),
    )
  );
}
export class TaskGroupsStore {
  private state: TaskGroupState;
  private stateStore: StateStore;
  constructor(stateStore: StateStore) {
    this.stateStore = stateStore;
    const value: unknown = stateStore.getTaskGroups() ?? emptyTaskGroups();
    if (!validState(value)) throw new Error("storage: 无效任务分组数据");
    this.state = value;
  }
  get(records: readonly SessionRecord[]): TaskGroupState {
    return reconcileTaskGroups(this.state, records);
  }
  prune(records: readonly SessionRecord[]): void {
    const next = this.get(records);
    if (JSON.stringify(next) === JSON.stringify(this.state)) return;
    this.stateStore.setTaskGroups(next);
    this.state = next;
  }
  update(input: unknown, records: readonly SessionRecord[]): TaskGroupState {
    if (!object(input) || typeof input.type !== "string") throw new Error("invalid_input: 无效分组操作");
    const keys: Record<string, string[]> = {
      create: ["type"],
      rename: ["type", "id", "title"],
      color: ["type", "id", "color"],
      delete: ["type", "id"],
      moveTask: ["type", "id", "groupId", "sourceGroupId", "before", "after", "start"],
      moveGroup: ["type", "id", "target", "position"],
      taskTop: ["type", "id"],
    };
    if (
      !Object.hasOwn(keys, input.type) ||
      Object.keys(input).some((key) => !keys[input.type as string].includes(key))
    )
      throw new Error("invalid_input: 未知分组操作");
    if (input.type !== "create" && (typeof input.id !== "string" || !input.id))
      throw new Error("invalid_input: 无效分组或任务 ID");
    if (
      (input.type === "rename" && typeof input.title !== "string") ||
      (input.type === "color" && !taskGroupColors.includes(input.color as never)) ||
      (input.type === "moveGroup" &&
        (!node(input.target) || !["before", "after"].includes(input.position as string))) ||
      (input.type === "moveTask" &&
        ((input.groupId !== null && typeof input.groupId !== "string") ||
          (input.sourceGroupId !== undefined &&
            input.sourceGroupId !== null &&
            typeof input.sourceGroupId !== "string") ||
          (input.before !== undefined && input.before !== null && !node(input.before)) ||
          (input.after !== undefined && !node(input.after)) ||
          (input.start !== undefined && typeof input.start !== "boolean")))
    )
      throw new Error("invalid_input: 无效分组操作参数");
    if (
      (input.type === "moveTask" || input.type === "taskTop") &&
      !records.some(
        (record) => record.id === input.id && !record.parentSessionId && record.archivedAt == null,
      )
    )
      throw new Error("not_found: 任务不存在");
    // 拖动开始后任务可能归档或删除；必须在权威记录上复验锚点，不能把旧落点降为末尾。
    for (const anchor of [input.before, input.after, input.target]) {
      if (
        node(anchor) &&
        anchor.type === "task" &&
        !records.some(
          (record) => record.id === anchor.id && !record.parentSessionId && record.archivedAt == null,
        )
      )
        throw new Error("invalid_input: 拖动目标已变化，请重试");
    }
    const command: TaskGroupCommand =
      input.type === "create"
        ? { type: "create", id: randomUUID(), createdAt: Date.now() }
        : (input as unknown as TaskGroupCommand);
    const next = applyTaskGroupCommand(this.get(records), command);
    this.stateStore.setTaskGroups(next);
    this.state = next;
    return structuredClone(next);
  }
}
