import { expect, it } from "vitest";
import {
  compareTasks,
  formatTaskRelativeTime,
  groupTimelineTasks,
  readTaskPreferences,
  retainProjectLimits,
  taskPage,
} from "../src/renderer/sidebar-task-model.ts";

const task = (id: string, createdAt: number, updatedAt: number, running = false) => ({
  id,
  createdAt,
  updatedAt,
  running,
});
it("sorts by selected time, secondary time, descending ID, with a stable running layer", () => {
  const tasks = [
    task("a", 1, 20),
    task("b", 2, 10),
    task("c", 2, 10),
    task("run-a", 4, 100, true),
    task("run-b", 5, 0, true),
  ];
  expect([...tasks].sort((a, b) => compareTasks(a, b, "updated")).map((t) => t.id)).toEqual([
    "run-b",
    "run-a",
    "a",
    "c",
    "b",
  ]);
  expect([...tasks].sort((a, b) => compareTasks(a, b, "created")).map((t) => t.id)).toEqual([
    "run-b",
    "run-a",
    "c",
    "b",
    "a",
  ]);
  expect(compareTasks(task("a", 1, 1, true), task("b", 1, 999, true), "updated")).toBeGreaterThan(0);
  expect(compareTasks({ ...task("a", 1, 1), status: "running" }, task("b", 2, 2), "updated")).toBeGreaterThan(
    0,
  );
});
it("formats the activity time using source floor boundaries", () => {
  const now = 1_000_000_000;
  for (const [age, label] of [
    [0, "刚刚"],
    [59999, "刚刚"],
    [60000, "1分"],
    [3599999, "59分"],
    [3600000, "1小时"],
    [86399999, "23小时"],
    [86400000, "1天"],
  ] as const)
    expect(formatTaskRelativeTime(now - age, now)).toBe(label);
});
it("validates both independent preferences including null and malformed JSON", () => {
  expect(readTaskPreferences(null)).toEqual({ organizeBy: "project", sortBy: "updated" });
  expect(readTaskPreferences('{"organizeBy":"chronological","sortBy":"bad"}')).toEqual({
    organizeBy: "chronological",
    sortBy: "updated",
  });
  for (const raw of ["null", "{}", "invalid", "[]"])
    expect(readTaskPreferences(raw)).toEqual({ organizeBy: "project", sortBy: "updated" });
});
it("paginates at 5/20 boundaries and hides stale hasMore once the current limit is not filled", () => {
  for (const size of [5, 20])
    for (const total of [size, size + 1, size * 2, size * 2 + 1]) {
      const tasks = Array.from({ length: total }, (_, i) => i);
      expect(taskPage(tasks, size).items).toHaveLength(size);
      expect(taskPage(tasks, size).hasMore).toBe(total > size);
      expect(taskPage(tasks, size * 2).items).toHaveLength(Math.min(total, size * 2));
      expect(taskPage(tasks, size * 3).hasMore).toBe(false);
    }
  expect(taskPage([1, 2], 20, { hasMore: true, total: 41, loading: false }).hasMore).toBe(false);
  expect(taskPage([1, 2], 20, { hasMore: true, total: 41, loading: true }).hasMore).toBe(true);
  expect(retainProjectLimits({ a: 10, b: 15 }, new Set(["a"]))).toEqual({ a: 10 });
});
it("groups by local calendar and selected time, preserving the running-first encounter order", () => {
  const date = (month: number, day: number, hour = 12) => new Date(2026, month - 1, day, hour).getTime();
  const now = date(10, 8);
  const dates = [date(8, 1), now, date(10, 7), date(10, 6), date(10, 5), date(10, 4), date(9, 30)];
  const items = dates.map((at, i) => task(String(i), at, now));
  expect(groupTimelineTasks(items, "created", now, "zh-CN").map((g) => g.label)).toEqual([
    "更早",
    "今天",
    "昨天",
    "2 天前",
    "3 天前",
    "上周",
  ]);
  expect(groupTimelineTasks(items, "updated", now, "zh-CN").map((g) => g.label)).toEqual(["今天"]);
  const sunday = [task("sun", date(10, 4), date(10, 4))];
  expect(groupTimelineTasks(sunday, "updated", now, "zh-CN")[0].label).toBe("上周");
  expect(groupTimelineTasks(sunday, "updated", now, "en-US")[0].label).toBe("This week");
  expect(
    groupTimelineTasks([task("y", date(10, 7, 23), date(10, 7, 23))], "updated", date(10, 8, 0), "zh-CN")[0]
      .label,
  ).toBe("昨天");
});

it("covers all calendar buckets in source order, including month and year transitions", () => {
  const at = (month: number, day: number) => new Date(2026, month - 1, day, 12).getTime();
  const now = at(10, 25);
  const dates = [
    at(10, 25),
    at(10, 24),
    at(10, 23),
    at(10, 22),
    at(10, 21),
    at(10, 18),
    at(10, 10),
    at(9, 25),
    at(8, 1),
  ];
  const items = dates.map((date, i) => task(String(i), date, date));
  expect(groupTimelineTasks(items, "updated", now).map((group) => group.label)).toEqual([
    "今天",
    "昨天",
    "2 天前",
    "3 天前",
    "本周",
    "上周",
    "本月",
    "上月",
    "更早",
  ]);
  const jan = new Date(2027, 0, 12, 0, 1).getTime();
  expect(groupTimelineTasks([task("dec", at(12, 31), at(12, 31))], "updated", jan)[0].label).toBe("上月");
});
