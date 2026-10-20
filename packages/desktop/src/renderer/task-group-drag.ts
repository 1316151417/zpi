// Drag lifecycle and final-position commands adapted from ZCode project-sidebar/grouped (Apache-2.0), 3c5b2276.
import { type CollisionDetection, closestCenter } from "@dnd-kit/core";
import {
  sameGroupNode,
  type TaskGroupCommand,
  type TaskGroupNode,
  type TaskGroupState,
  taskGroupFor,
} from "../shared/task-groups.ts";
export type GroupDropTarget =
  | TaskGroupNode
  | { type: "header" | "footer" | "empty" | "collapsed"; id: string };
// ZCode separates whole-group reorder targets from task header/footer/empty targets.
export const taskGroupCollisionDetection: CollisionDetection = (args) => {
  const active = args.active.data.current as TaskGroupNode | undefined;
  return closestCenter({
    ...args,
    droppableContainers: args.droppableContainers.filter((container) => {
      const target = container.data.current as GroupDropTarget | undefined;
      return active?.type === "group"
        ? target?.type === "group" || target?.type === "task"
        : target?.type !== "group";
    }),
  });
};

/** Commit the dragged node relative to its final visible neighbors, as in ZCode groupedMoveCommand. */
export function taskGroupMoveCommand(
  origin: TaskGroupState,
  preview: TaskGroupState,
  source: TaskGroupNode,
  visibleTaskIds?: ReadonlySet<string>,
): TaskGroupCommand | undefined {
  const locate = (state: TaskGroupState) => {
    const groupId = source.type === "task" ? taskGroupFor(state, source.id) : null;
    const siblings: TaskGroupNode[] = (
      groupId ? (state.members[groupId] ?? []).map((id) => ({ type: "task" as const, id })) : state.roots
    ).filter((node) => node.type === "group" || !visibleTaskIds || visibleTaskIds.has(node.id));
    return { groupId, siblings, index: siblings.findIndex((node) => sameGroupNode(node, source)) };
  };
  const before = locate(origin),
    after = locate(preview);
  if (
    before.index < 0 ||
    after.index < 0 ||
    (before.groupId === after.groupId && before.index === after.index)
  )
    return;
  const next = after.siblings[after.index + 1],
    previous = after.siblings[after.index - 1];
  if (source.type === "group") {
    const target = next ?? previous;
    return target
      ? { type: "moveGroup", id: source.id, target, position: next ? "before" : "after" }
      : undefined;
  }
  return {
    type: "moveTask",
    id: source.id,
    sourceGroupId: before.groupId,
    groupId: after.groupId,
    ...(next ? { before: next } : previous ? { after: previous } : { start: true }),
  };
}

export function taskGroupOrderSignature(state: TaskGroupState): string {
  return JSON.stringify([state.roots, state.members]);
}
/** ZCode: upward over a header = root-before, downward = group-start; footer is the inverse. */
export function taskGroupDropCommand(
  state: TaskGroupState,
  active: TaskGroupNode,
  over: GroupDropTarget,
  position: "before" | "after",
): TaskGroupCommand | undefined {
  if (active.type === "group") {
    const target: TaskGroupNode = over.type === "task" ? over : { type: "group", id: over.id };
    const targetGroupId = target.type === "group" ? target.id : taskGroupFor(state, target.id);
    // 重排后自身目标会跟到指针下；忽略它，保留最后有效预览，避免用 origin 重算而跳回原位。
    if (targetGroupId === active.id) return;
    return { type: "moveGroup", id: active.id, target, position };
  }
  if (over.type === "task") {
    if (active.id === over.id) return;
    return { type: "moveTask", id: active.id, groupId: taskGroupFor(state, over.id), [position]: over };
  }
  if (over.type === "empty" || (over.type === "header" && position === "after")) {
    return { type: "moveTask", id: active.id, groupId: over.id, start: true };
  }
  if (over.type === "footer" && position === "before") {
    return { type: "moveTask", id: active.id, groupId: over.id, before: null };
  }
  return { type: "moveTask", id: active.id, groupId: null, [position]: { type: "group", id: over.id } };
}

export interface TaskGroupDragMotion {
  deltaY: number;
  position: "before" | "after";
  target?: GroupDropTarget;
}
export function taskGroupDragMotion(
  previous: TaskGroupDragMotion,
  deltaY: number,
  target = previous.target,
): TaskGroupDragMotion {
  return {
    deltaY,
    target,
    position: deltaY > previous.deltaY ? "after" : deltaY < previous.deltaY ? "before" : previous.position,
  };
}
export function canStartTaskGroupDrag(
  event: { isPrimary: boolean; button: number },
  interactiveControl: boolean,
  dragTitle = false,
): boolean {
  return event.isPrimary && event.button === 0 && (!interactiveControl || dragTitle);
}
export function taskGroupRowDragProps(active: TaskGroupNode | undefined, id: string, hidden = false) {
  return {
    dragging: active?.type === "task" && active.id === id,
    tooltipsDisabled: Boolean(active) || hidden,
    interactionDisabled: hidden,
  };
}
