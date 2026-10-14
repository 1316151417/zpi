import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { TaskGroupsStore } from "../src/main/task-groups.ts";
import { taskGroupDropCommand } from "../src/renderer/task-group-drag.ts";
import { parseCollapsedTaskGroups, pruneCollapsedTaskGroups } from "../src/renderer/task-group-expansion.ts";
import type { SessionRecord } from "../src/shared/bridge.ts";
import {
  applyTaskGroupCommand,
  emptyTaskGroups,
  reconcileTaskGroups,
  type TaskGroupState,
  taskGroupFor,
} from "../src/shared/task-groups.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const task = (id: string, createdAt = 1, patch: Partial<SessionRecord> = {}): SessionRecord => ({
  id,
  title: id,
  projectId: null,
  createdAt,
  updatedAt: createdAt,
  ...patch,
});
const records = [task("a", 3), task("b", 2), task("c", 1)];
function fixture(): TaskGroupState {
  let state = reconcileTaskGroups(emptyTaskGroups(), records);
  state = applyTaskGroupCommand(state, { type: "create", id: "g", createdAt: 4 });
  state = applyTaskGroupCommand(state, { type: "create", id: "h", createdAt: 5 });
  return applyTaskGroupCommand(state, { type: "moveTask", id: "a", groupId: "g" });
}
const roots = (state: TaskGroupState) => state.roots.map((node) => `${node.type}:${node.id}`);
it("imports legacy tasks once in creation order, excluding child sessions, without reacting to activity timestamps", () => {
  let state = reconcileTaskGroups(emptyTaskGroups(), [
    ...records,
    task("child", 10, { parentSessionId: "a" }),
  ]);
  expect(roots(state)).toEqual(["task:a", "task:b", "task:c"]);
  state = applyTaskGroupCommand(state, { type: "taskTop", id: "c" });
  expect(
    roots(
      reconcileTaskGroups(
        state,
        records.map((record) => ({ ...record, updatedAt: 999 })),
      ),
    ),
  ).toEqual(["task:c", "task:a", "task:b"]);
});
it("creates gray groups at root top; allows duplicate titles, trims names and preserves blank names", () => {
  let state = fixture();
  expect(state.groups[0]).toMatchObject({ title: "New Group", color: "gray" });
  state = applyTaskGroupCommand(state, { type: "rename", id: "g", title: "  同名  " });
  state = applyTaskGroupCommand(state, { type: "rename", id: "h", title: "同名" });
  state = applyTaskGroupCommand(state, { type: "rename", id: "h", title: "  " });
  expect(state.groups.map((group) => group.title)).toEqual(["同名", "同名"]);
  expect(roots(state)).toEqual(["group:h", "group:g", "task:b", "task:c"]);
});
it("appends menu moves, transfers one membership and removes immediately after the original group", () => {
  let state = applyTaskGroupCommand(fixture(), { type: "moveTask", id: "b", groupId: "g" });
  expect(state.members.g).toEqual(["a", "b"]);
  state = applyTaskGroupCommand(state, { type: "moveTask", id: "a", groupId: "h" });
  expect(state.members).toEqual({ g: ["b"], h: ["a"] });
  state = applyTaskGroupCommand(state, { type: "moveTask", id: "a", groupId: null });
  expect(roots(state)).toEqual(["group:h", "task:a", "group:g", "task:c"]);
});
it("move-to-top preserves the parent and root groups can move around root tasks or another group's members", () => {
  let state = applyTaskGroupCommand(fixture(), { type: "moveTask", id: "b", groupId: "g" });
  state = applyTaskGroupCommand(state, { type: "taskTop", id: "b" });
  expect(state.members.g).toEqual(["b", "a"]);
  state = applyTaskGroupCommand(state, {
    type: "moveGroup",
    id: "h",
    target: { type: "task", id: "a" },
    position: "after",
  });
  expect(roots(state)).toEqual(["group:g", "group:h", "task:c"]);
  expect(
    applyTaskGroupCommand(state, {
      type: "moveGroup",
      id: "g",
      target: { type: "task", id: "a" },
      position: "after",
    }),
  ).toBe(state);
});
it("ungroup replaces the group with all members, preserving hidden pinned/archived tasks and order", () => {
  let state = applyTaskGroupCommand(fixture(), { type: "moveTask", id: "b", groupId: "g" });
  state = reconcileTaskGroups(state, [
    task("a", 3, { pinnedAt: 1 }),
    task("b", 2, { archivedAt: 1 }),
    task("c"),
  ]);
  state = applyTaskGroupCommand(state, { type: "delete", id: "g" });
  expect(roots(state)).toEqual(["group:h", "task:a", "task:b", "task:c"]);
  expect(taskGroupFor(state, "a")).toBe(null);
});
it("unrelated reorder keeps hidden memberships and their positions; permanent deletion prunes only missing tasks", () => {
  const state = applyTaskGroupCommand(fixture(), { type: "moveTask", id: "b", groupId: "g" });
  const hidden = [task("a", 3, { pinnedAt: 1 }), task("b", 2, { archivedAt: 1 }), task("c")];
  const reordered = applyTaskGroupCommand(reconcileTaskGroups(state, hidden), { type: "taskTop", id: "c" });
  expect(reconcileTaskGroups(reordered, records).members.g).toEqual(["a", "b"]);
  expect(
    reconcileTaskGroups(
      reordered,
      records.filter((record) => record.id !== "a"),
    ).members.g,
  ).toEqual(["b"]);
});
it.each([
  ["header", "before", null, "before"],
  ["header", "after", "g", "start"],
  ["footer", "before", "g", "before"],
  ["footer", "after", null, "after"],
  ["collapsed", "before", null, "before"],
  ["collapsed", "after", null, "after"],
  ["empty", "before", "g", "start"],
  ["empty", "after", "g", "start"],
] as const)(
  "maps task drag over %s in %s direction to source parent/boundary",
  (type, position, groupId, property) => {
    const command = taskGroupDropCommand(fixture(), { type: "task", id: "c" }, { type, id: "g" }, position);
    expect(command).toMatchObject({ type: "moveTask", id: "c", groupId });
    expect(command).toHaveProperty(property);
  },
);
it("task-over-task chooses the destination parent, with correct downward insert index", () => {
  const state = applyTaskGroupCommand(fixture(), { type: "moveTask", id: "b", groupId: "g" });
  const command = taskGroupDropCommand(state, { type: "task", id: "a" }, { type: "task", id: "b" }, "after");
  expect(command && applyTaskGroupCommand(state, command).members.g).toEqual(["b", "a"]);
});
it("retains collapsed IDs before hydration, prunes only after loading, and handles malformed local preferences", () => {
  const saved = parseCollapsedTaskGroups('["g","g","h",null]');
  expect(saved).toEqual(["g", "h"]);
  expect(pruneCollapsedTaskGroups(saved, [], false)).toBe(saved);
  expect(pruneCollapsedTaskGroups(saved, ["g"], true)).toEqual(["g"]);
  for (const raw of [null, "broken", "{}", "null"]) expect(parseCollapsedTaskGroups(raw)).toEqual([]);
});
it("persists updates atomically and restores names, colors, membership and order after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-groups-"));
  directories.push(dir);
  const path = join(dir, "task-groups.json");
  const store = new TaskGroupsStore(path);
  const group = store.update({ type: "create" }, records).groups[0];
  store.update({ type: "rename", id: group.id, title: "持久组" }, records);
  store.update({ type: "color", id: group.id, color: "purple" }, records);
  store.update({ type: "moveTask", id: "a", groupId: group.id }, records);
  expect(new TaskGroupsStore(path).get(records)).toEqual(store.get(records));
  expect(JSON.parse(await readFile(path, "utf8")).groups[0]).toMatchObject({
    title: "持久组",
    color: "purple",
  });
});
it("rejects malformed commands, unknown tasks/groups and corrupt data without resetting state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-groups-invalid-"));
  directories.push(dir);
  const path = join(dir, "task-groups.json");
  const store = new TaskGroupsStore(path);
  for (const input of [
    null,
    { type: "evil" },
    { type: "create", id: "spoofed" },
    { type: "color", id: "g", color: "pink" },
    { type: "moveTask", id: "missing", groupId: null },
    { type: "rename", id: "missing", title: "x" },
    { type: "moveTask", id: "a", groupId: "missing" },
  ])
    expect(() => store.update(input, records)).toThrow();
  await writeFile(path, '{"version":99}');
  expect(() => new TaskGroupsStore(path)).toThrow("storage:");
});
it("a failed disk write leaves the in-memory state unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-groups-write-"));
  directories.push(dir);
  const path = join(dir, "task-groups.json");
  const store = new TaskGroupsStore(path);
  await mkdir(path);
  expect(() => store.update({ type: "create" }, records)).toThrow();
  expect(store.get(records).groups).toEqual([]);
});

it("recomputes on drag-move direction reversal even when the target ID does not change", async () => {
  const { taskGroupDragEvent } = await import("../src/renderer/task-group-drag.ts");
  const state = fixture();
  const active = { type: "task", id: "c" } as const;
  const target = { type: "task", id: "b" } as const;
  const first = taskGroupDragEvent(state, active, { deltaY: 0, position: "after" }, -10, target);
  expect(first.command).toMatchObject({ before: target, groupId: null });
  const reverse = taskGroupDragEvent(state, active, first.motion, -4, target);
  expect(reverse.command).toMatchObject({ after: target, groupId: null });
  expect(reverse.command && roots(applyTaskGroupCommand(state, reverse.command))).toEqual([
    "group:h",
    "group:g",
    "task:b",
    "task:c",
  ]);
  const grouped = applyTaskGroupCommand(state, { type: "moveTask", id: "b", groupId: "g" });
  const down = taskGroupDragEvent(
    grouped,
    { type: "task", id: "a" },
    { deltaY: 0, position: "after" },
    6,
    target,
  );
  expect(down.command && applyTaskGroupCommand(grouped, down.command).members.g).toEqual(["b", "a"]);
  const up = taskGroupDragEvent(grouped, { type: "task", id: "a" }, down.motion, 3, target);
  expect(up.command && applyTaskGroupCommand(grouped, up.command).members.g).toEqual(["a", "b"]);
  const header = { type: "header", id: "g" } as const;
  const headerDown = taskGroupDragEvent(state, active, first.motion, -2, header);
  expect(headerDown.command).toMatchObject({ groupId: "g", start: true });
  const headerUp = taskGroupDragEvent(state, active, headerDown.motion, -3, header);
  expect(headerUp.command).toMatchObject({ groupId: null, before: { type: "group", id: "g" } });
});

it("keeps the last valid group preview and drop when reordered content collides with itself", async () => {
  const { taskGroupDragEvent } = await import("../src/renderer/task-group-drag.ts");
  const origin = fixture();
  const active = { type: "group", id: "g" } as const;
  const first = taskGroupDragEvent(origin, active, { deltaY: 0, position: "after" }, 80, {
    type: "task",
    id: "c",
  });
  expect(first.command).toBeDefined();
  if (!first.command) throw new Error("missing initial group move");
  let lastCommand = first.command;
  let preview = applyTaskGroupCommand(origin, lastCommand);
  const expected = ["group:h", "task:b", "task:c", "group:g"];
  expect(roots(preview)).toEqual(expected);
  for (const target of [
    { type: "header", id: "g" },
    { type: "collapsed", id: "g" },
    { type: "footer", id: "g" },
    { type: "empty", id: "g" },
    { type: "group", id: "g" },
    { type: "task", id: "a" },
  ] as const) {
    const self = taskGroupDragEvent(origin, active, first.motion, 75, target);
    expect(self.command).toBeUndefined();
    if (self.command) {
      lastCommand = self.command;
      preview = applyTaskGroupCommand(origin, lastCommand);
    }
    expect(roots(preview)).toEqual(expected);
  }
  expect(roots(applyTaskGroupCommand(origin, lastCommand))).toEqual(expected);
});

it("limits drag activation to the primary left pointer, without stealing color, menu, or input controls", async () => {
  const { canStartTaskGroupDrag } = await import("../src/renderer/task-group-drag.ts");
  for (const button of [1, 2]) expect(canStartTaskGroupDrag({ isPrimary: true, button }, false)).toBe(false);
  expect(canStartTaskGroupDrag({ isPrimary: false, button: 0 }, false)).toBe(false);
  expect(canStartTaskGroupDrag({ isPrimary: true, button: 0 }, true)).toBe(false);
  expect(canStartTaskGroupDrag({ isPrimary: true, button: 0 }, true, true)).toBe(true);
  expect(canStartTaskGroupDrag({ isPrimary: true, button: 0 }, false)).toBe(true);
});
it("lists menu groups in their visible root order after drag reorder", async () => {
  const { orderedTaskGroups } = await import("../src/shared/task-groups.ts");
  const state = applyTaskGroupCommand(fixture(), {
    type: "moveGroup",
    id: "g",
    target: { type: "group", id: "h" },
    position: "before",
  });
  expect(orderedTaskGroups(state).map((group) => group.id)).toEqual(["g", "h"]);
});

it("root and group task rows suppress every tooltip while any task or group is being dragged", async () => {
  const { taskGroupRowDragProps } = await import("../src/renderer/task-group-drag.ts");
  expect(taskGroupRowDragProps(undefined, "a")).toEqual({
    dragging: false,
    tooltipsDisabled: false,
    interactionDisabled: false,
  });
  expect(taskGroupRowDragProps({ type: "task", id: "a" }, "a")).toEqual({
    dragging: true,
    tooltipsDisabled: true,
    interactionDisabled: false,
  });
  expect(taskGroupRowDragProps({ type: "task", id: "b" }, "a")).toEqual({
    dragging: false,
    tooltipsDisabled: true,
    interactionDisabled: false,
  });
  expect(taskGroupRowDragProps({ type: "group", id: "g" }, "a")).toEqual({
    dragging: false,
    tooltipsDisabled: true,
    interactionDisabled: false,
  });
  expect(taskGroupRowDragProps(undefined, "a", true)).toEqual({
    dragging: false,
    tooltipsDisabled: true,
    interactionDisabled: true,
  });
});
it("refreshes live change totals on later hovers, deduplicates in-flight reads and retries after failure", async () => {
  const { refreshTaskGroupChangeSummary } = await import("../src/renderer/task-group-tooltip.ts");
  const inFlight = { current: false };
  const values: { added: number; removed: number }[] = [];
  let finish!: (value: { added: number; removed: number }[]) => void;
  const pending = refreshTaskGroupChangeSummary(
    inFlight,
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    (value) => values.push(value),
  );
  await refreshTaskGroupChangeSummary(
    inFlight,
    async () => {
      throw new Error("must not overlap");
    },
    (value) => values.push(value),
  );
  finish([{ added: 1, removed: 2 }]);
  await pending;
  await refreshTaskGroupChangeSummary(
    inFlight,
    async () => [{ added: 4, removed: 3 }],
    (value) => values.push(value),
  );
  await expect(
    refreshTaskGroupChangeSummary(
      inFlight,
      async () => {
        throw new Error("read failed");
      },
      () => {},
    ),
  ).rejects.toThrow("read failed");
  expect(inFlight.current).toBe(false);
  await refreshTaskGroupChangeSummary(
    inFlight,
    async () => [{ added: 8, removed: 0 }],
    (value) => values.push(value),
  );
  expect(values).toEqual([
    { added: 1, removed: 2 },
    { added: 4, removed: 3 },
    { added: 8, removed: 0 },
  ]);
});
