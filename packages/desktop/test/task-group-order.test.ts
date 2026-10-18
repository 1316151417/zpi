import { expect, it } from "vitest";
import { orderTaskGroups } from "../src/renderer/task-group-order.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";
import type { TaskGroupState } from "../src/shared/task-groups.ts";

const task = (id: string, createdAt: number, updatedAt: number, running = false): SessionRecord => ({
  id,
  title: id,
  projectId: null,
  createdAt,
  updatedAt,
  running,
});
const records = [task("new", 30, 30), task("old-active", 10, 60), task("middle", 20, 40)];
const allRecords = [...records, ...records.map((record) => ({ ...record, id: `g-${record.id}` }))];
const state: TaskGroupState = {
  version: 1,
  groups: [{ id: "g", title: "Group", color: "gray", createdAt: 50 }],
  roots: [
    { type: "task", id: "new" },
    { type: "group", id: "g" },
    { type: "task", id: "old-active" },
    { type: "task", id: "middle" },
  ],
  members: { g: ["g-new", "g-old-active", "g-middle"] },
};

it.each([
  ["updated", ["old-active", "middle", "new"]],
  ["created", ["new", "middle", "old-active"]],
] as const)(
  "orders root and grouped tasks by %s while preserving group positions and saved manual order",
  (sortBy, expected) => {
    const saved = structuredClone(state);
    const ordered = orderTaskGroups(state, allRecords, sortBy);
    expect(ordered.roots.map((node) => node.id)).toEqual([expected[0], "g", ...expected.slice(1)]);
    expect(ordered.members.g).toEqual(expected.map((id) => `g-${id}`));
    expect(state).toEqual(saved);
    expect(orderTaskGroups(state, records, "manual")).toBe(state);
  },
);

it("responds to activity changes and keeps running tasks first using the existing task ordering", () => {
  const active = allRecords.map((record) => (record.id === "g-new" ? { ...record, updatedAt: 100 } : record));
  expect(orderTaskGroups(state, active, "updated").members.g).toEqual(["g-new", "g-old-active", "g-middle"]);
  expect(orderTaskGroups(state, [...active, task("g-middle", 20, 40, true)], "updated").members.g).toEqual([
    "g-middle",
    "g-new",
    "g-old-active",
  ]);
});

it("retains task references missing from a partial refresh without changing membership or throwing", () => {
  expect(orderTaskGroups(state, [allRecords[4]], "updated").members.g).toEqual([
    "g-old-active",
    "g-new",
    "g-middle",
  ]);
  expect(orderTaskGroups(state, [], "updated")).toEqual(state);
});
