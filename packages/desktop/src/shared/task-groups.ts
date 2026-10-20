// Adapted from ZCode workspace-grouped-tasks/view and types (Apache-2.0), aac4755666.
import type { SessionRecord } from "./bridge.ts";

export const taskGroupColors = ["gray", "red", "orange", "yellow", "green", "blue", "purple"] as const;
export type TaskGroupColor = (typeof taskGroupColors)[number];
export interface TaskGroup {
  id: string;
  title: string;
  color: TaskGroupColor;
  createdAt: number;
}
export type TaskGroupNode = { type: "group" | "task"; id: string };
export interface TaskGroupState {
  version: 1;
  groups: TaskGroup[];
  roots: TaskGroupNode[];
  members: Record<string, string[]>;
}
export type TaskGroupCommand =
  | { type: "create"; id: string; createdAt: number }
  | { type: "rename"; id: string; title: string }
  | { type: "color"; id: string; color: TaskGroupColor }
  | { type: "delete"; id: string }
  | {
      type: "moveTask";
      id: string;
      groupId: string | null;
      sourceGroupId?: string | null;
      before?: TaskGroupNode | null;
      after?: TaskGroupNode;
      start?: boolean;
    }
  | { type: "moveGroup"; id: string; target: TaskGroupNode; position: "before" | "after" }
  | { type: "taskTop"; id: string };
export const emptyTaskGroups = (): TaskGroupState => ({ version: 1, groups: [], roots: [], members: {} });
export function taskGroupFor(state: TaskGroupState, id: string): string | null {
  return state.groups.find((group) => state.members[group.id]?.includes(id))?.id ?? null;
}
export function sameGroupNode(a: TaskGroupNode, b: TaskGroupNode) {
  return a.type === b.type && a.id === b.id;
}
/** Add legacy/new tasks once, without allowing runtime timestamps or hidden rows to reorder existing nodes. */
export function reconcileTaskGroups(
  state: TaskGroupState,
  records: readonly SessionRecord[],
): TaskGroupState {
  const next = structuredClone(state);
  const tasks = records.filter((record) => !record.parentSessionId);
  const ids = new Set(tasks.map((record) => record.id));
  const seen = new Set<string>();
  for (const group of next.groups) {
    next.members[group.id] = (next.members[group.id] ?? []).filter((id) => {
      if (!ids.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
  }
  const groupIds = new Set(next.groups.map((group) => group.id));
  const seenGroups = new Set<string>();
  next.roots = next.roots.filter((node) => {
    if (node.type === "group") {
      if (!groupIds.has(node.id) || seenGroups.has(node.id)) return false;
      seenGroups.add(node.id);
    } else {
      if (!ids.has(node.id) || seen.has(node.id)) return false;
      seen.add(node.id);
    }
    return true;
  });
  next.roots.push(
    ...next.groups
      .filter((group) => !seenGroups.has(group.id))
      .map((group) => ({ type: "group" as const, id: group.id })),
  );
  next.roots.push(
    ...tasks
      .filter((record) => !seen.has(record.id))
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .map((record) => ({ type: "task" as const, id: record.id })),
  );
  return next;
}
export function applyTaskGroupCommand(state: TaskGroupState, command: TaskGroupCommand): TaskGroupState {
  const next = structuredClone(state);
  const group = () => {
    const found = next.groups.find((entry) => entry.id === command.id);
    if (!found) throw new Error("not_found: 分组不存在");
    return found;
  };
  const removeTask = (id: string) => {
    for (const entry of next.groups)
      next.members[entry.id] = next.members[entry.id].filter((member) => member !== id);
    next.roots = next.roots.filter((node) => node.type !== "task" || node.id !== id);
  };
  switch (command.type) {
    case "create":
      if (next.groups.some((entry) => entry.id === command.id)) return state;
      next.groups.push({ id: command.id, title: "New Group", color: "gray", createdAt: command.createdAt });
      next.members[command.id] = [];
      next.roots.unshift({ type: "group", id: command.id });
      break;
    case "rename": {
      const value = group();
      value.title = command.title.trim() || value.title;
      break;
    }
    case "color":
      if (!taskGroupColors.includes(command.color)) throw new Error("invalid_input: 无效分组颜色");
      group().color = command.color;
      break;
    case "delete": {
      group();
      const index = next.roots.findIndex((node) => node.type === "group" && node.id === command.id);
      next.roots.splice(index, 1, ...next.members[command.id].map((id) => ({ type: "task" as const, id })));
      next.groups = next.groups.filter((entry) => entry.id !== command.id);
      delete next.members[command.id];
      break;
    }
    case "taskTop": {
      const groupId = taskGroupFor(next, command.id);
      removeTask(command.id);
      if (groupId) next.members[groupId].unshift(command.id);
      else next.roots.unshift({ type: "task", id: command.id });
      break;
    }
    case "moveTask": {
      if (command.groupId && !next.groups.some((entry) => entry.id === command.groupId))
        throw new Error("not_found: 分组不存在");
      const currentGroup = taskGroupFor(next, command.id);
      if (command.sourceGroupId !== undefined && currentGroup !== command.sourceGroupId)
        throw new Error("invalid_input: 任务分组已变化，请重试");
      const anchor = command.after ?? command.before;
      if (anchor) {
        const valid = command.groupId
          ? anchor.type === "task" && next.members[command.groupId].includes(anchor.id)
          : next.roots.some((node) => sameGroupNode(node, anchor));
        if (!valid || (anchor.type === "task" && anchor.id === command.id))
          throw new Error("invalid_input: 拖动目标已变化，请重试");
      }
      const menuMove = command.before === undefined && command.after === undefined && !command.start;
      if (menuMove && currentGroup === command.groupId) return state;
      removeTask(command.id);
      if (command.groupId) {
        const items = next.members[command.groupId];
        const anchor = command.after ?? command.before;
        const index = anchor ? items.indexOf(anchor.id) : -1;
        items.splice(
          command.start ? 0 : index >= 0 ? index + (command.after ? 1 : 0) : items.length,
          0,
          command.id,
        );
      } else {
        const anchor = command.after ?? command.before;
        const index = anchor ? next.roots.findIndex((node) => sameGroupNode(node, anchor)) : -1;
        const oldGroupIndex = currentGroup
          ? next.roots.findIndex((node) => node.type === "group" && node.id === currentGroup)
          : -1;
        next.roots.splice(
          command.start
            ? 0
            : index >= 0
              ? index + (command.after ? 1 : 0)
              : menuMove && oldGroupIndex >= 0
                ? oldGroupIndex + 1
                : next.roots.length,
          0,
          { type: "task", id: command.id },
        );
      }
      break;
    }
    case "moveGroup": {
      group();
      const target =
        command.target.type === "task" && taskGroupFor(next, command.target.id)
          ? { type: "group" as const, id: taskGroupFor(next, command.target.id) as string }
          : command.target;
      if (target.type === "group" && target.id === command.id) return state;
      const targetIndex = next.roots.findIndex((node) => sameGroupNode(node, target));
      if (targetIndex < 0) throw new Error("invalid_input: 拖动目标已变化，请重试");
      next.roots = next.roots.filter((node) => node.type !== "group" || node.id !== command.id);
      const index = next.roots.findIndex((node) => sameGroupNode(node, target));
      next.roots.splice(index + (command.position === "after" ? 1 : 0), 0, { type: "group", id: command.id });
      break;
    }
  }
  return next;
}

export function orderedTaskGroups(state: TaskGroupState): TaskGroup[] {
  return state.roots.flatMap((node) =>
    node.type === "group" ? (state.groups.find((group) => group.id === node.id) ?? []) : [],
  );
}
