import {
  type TaskGroupCommand,
  type TaskGroupNode,
  type TaskGroupState,
  taskGroupFor,
} from "../shared/task-groups.ts";
export type GroupDropTarget =
  | TaskGroupNode
  | { type: "header" | "footer" | "empty" | "collapsed"; id: string };
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
/** Shared by drag-over and every drag-move, including reversal within the same droppable ID. */
export function taskGroupDragEvent(
  state: TaskGroupState,
  active: TaskGroupNode,
  previous: TaskGroupDragMotion,
  deltaY: number,
  target = previous.target,
) {
  const motion = taskGroupDragMotion(previous, deltaY, target);
  return {
    motion,
    command: motion.target ? taskGroupDropCommand(state, active, motion.target, motion.position) : undefined,
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
