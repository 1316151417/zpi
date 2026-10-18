import type { SessionRecord } from "../shared/bridge.ts";
import type { TaskGroupState } from "../shared/task-groups.ts";
import { compareTasks, type GroupTaskSortBy } from "./sidebar-task-model.ts";

/** Derive the visible task order without overwriting manual positions or group membership. */
export function orderTaskGroups(
  state: TaskGroupState,
  records: readonly SessionRecord[],
  sortBy: GroupTaskSortBy,
): TaskGroupState {
  if (sortBy === "manual") return state;
  const tasks = new Map(records.map((record) => [record.id, record]));
  const compare = (a: string, b: string) => {
    const left = tasks.get(a);
    const right = tasks.get(b);
    if (!left || !right) return Number(Boolean(right)) - Number(Boolean(left));
    return compareTasks(left, right, sortBy);
  };
  const roots = state.roots.filter((node) => node.type === "task").sort((a, b) => compare(a.id, b.id));
  let index = 0;
  return {
    ...state,
    roots: state.roots.map((node) => (node.type === "group" ? node : roots[index++])),
    members: Object.fromEntries(
      Object.entries(state.members).map(([id, members]) => [id, [...members].sort(compare)]),
    ),
  };
}
