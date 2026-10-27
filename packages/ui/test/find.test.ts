import { describe, expect, it, vi } from "vitest";
import {
  buildFindMatches,
  FindIndex,
  findKeyDirection,
  findSearchTargetIndex,
  moveFindIndex,
} from "../src/find.ts";
import { patchFindTargets } from "../src/patch-find.ts";

describe("task find", () => {
  it("finds literal, case-insensitive, non-overlapping occurrences in conversation order", () => {
    const targets = [
      { key: "user", text: "项目 PROJECT 项目" },
      { key: "answer", text: "project a.b aab" },
    ];
    expect(
      buildFindMatches(targets, "  ProJect  ").map(({ key, start, end }) => ({ key, start, end })),
    ).toEqual([
      { key: "user", start: 3, end: 10 },
      { key: "answer", start: 0, end: 7 },
    ]);
    expect(buildFindMatches(targets, "项目")).toHaveLength(2);
    expect(buildFindMatches(targets, "a.b")).toHaveLength(1);
    expect(buildFindMatches([{ key: "a", text: "aaaa" }], "aa")).toHaveLength(2);
    expect(buildFindMatches(targets, " \n ")).toEqual([]);
  });
  it("keeps offsets valid for emoji and length-changing Unicode case folds", () => {
    const target = { key: "a", text: "😀İ 项目 σς" };
    expect(buildFindMatches([target], "项目")[0]).toMatchObject({ start: 4, end: 6 });
    expect(buildFindMatches([target], "İ")[0]).toMatchObject({ start: 2, end: 3 });
    expect(buildFindMatches([target], "😀")[0]).toMatchObject({ start: 0, end: 2 });
    expect(buildFindMatches([{ key: "b", text: "ΟΣ" }], "ος")).toHaveLength(1);
  });
  it("wraps keyboard navigation and leaves zero results inactive", () => {
    expect(moveFindIndex({ total: 3, activeIndex: 0 }, "previous")).toBe(2);
    expect(moveFindIndex({ total: 3, activeIndex: 2 }, "next")).toBe(0);
    expect(moveFindIndex({ total: 1, activeIndex: 0 }, "next")).toBe(0);
    expect(moveFindIndex({ total: 0, activeIndex: -1 }, "next")).toBe(-1);
    expect(findKeyDirection("Enter", true)).toBe("previous");
    expect(findKeyDirection("ArrowDown", true)).toBe("next");
    expect(findKeyDirection("Escape", false)).toBeUndefined();
  });
  it("indexes diff content in renderer order and excludes file and hunk headers", () => {
    const patch =
      "diff --git a/project.txt b/project.txt\n--- a/project.txt\n+++ b/project.txt\n@@ -1,2 +1,2 @@ project header\n keep project\n-old project\n+new project\n";
    const targets = patchFindTargets("file", "project.txt", patch);
    expect(targets.map(({ key, text }) => ({ key, text }))).toEqual([
      { key: "file:0", text: "keep project" },
      { key: "file:1", text: "old project" },
      { key: "file:2", text: "new project" },
    ]);
    expect(buildFindMatches(targets, "project")).toHaveLength(3);
    expect(buildFindMatches(targets, "header")).toHaveLength(0);
  });
});

it("reuses stable target matches and case folds across navigation, streaming and query changes", () => {
  const targets = Array.from({ length: 200 }, (_, i) => ({ key: `run-${i}`, text: `Needle history ${i}` }));
  const index = new FindIndex();
  const initial = index.search(targets, "needle");
  const fold = vi.spyOn(String.prototype, "toLocaleLowerCase");
  try {
    const again = index.search(
      targets.map((target) => ({ ...target })),
      "needle",
    );
    expect(again).toEqual(initial);
    expect(again[0]).toBe(initial[0]);
    expect(fold.mock.contexts.filter((value) => String(value).includes("history"))).toHaveLength(0);
    const streamed = index.search(
      [...targets.slice(0, -1), { ...targets[199], text: "Needle new tail" }],
      "needle",
    );
    expect(streamed[0]).toBe(initial[0]);
    expect(streamed[199]).not.toBe(initial[199]);
    expect(streamed[199].text).toBe("Needle new tail");
    index.search(targets.slice(0, -1), "history");
    expect(fold.mock.contexts.filter((value) => String(value).startsWith("Needle history"))).toHaveLength(0);
  } finally {
    fold.mockRestore();
  }
});

it("drops removed targets, releases closed searches and invalidates changed paths", () => {
  const index = new FindIndex();
  const target = { key: "a", text: "needle", path: "before.ts" };
  const initial = index.search([target], "needle")[0];
  const changed = index.search([{ ...target, path: "after.ts" }], "needle")[0];
  expect(changed.path).toBe("after.ts");
  expect(changed).not.toBe(initial);
  index.search([], "needle");
  const returned = index.search([target], "needle")[0];
  expect(returned).not.toBe(initial);
  expect(index.search([target], " ")).toEqual([]);
  expect(index.search([target], "needle")[0]).not.toBe(returned);
  index.clear();
  expect(index.search([target], "needle")[0]).not.toBe(returned);
});

it.each(["😀", "İ", "项目", "ος", "aa", "不存在"])(
  "cached search preserves literal offsets for %s",
  (query) => {
    const targets = [{ key: "a", text: "😀İ 项目 ΟΣ aaaa" }];
    const index = new FindIndex();
    expect(index.search(targets, query)).toEqual(buildFindMatches(targets, query));
    expect(index.search(targets, query)).toEqual(buildFindMatches(targets, query));
  },
);

it("locates the chosen snippet among repeated hits in a single turn after history loads", () => {
  const text = "first needle apple and second needle orange and third needle pear";
  const matches = buildFindMatches([{ key: "run:answer", text }], "needle");
  expect(
    findSearchTargetIndex(matches, {
      query: "needle",
      activeIndex: 0,
      navigationId: 1,
      targetRunId: "run",
      matchBefore: "second ",
      matchAfter: " orange",
    }),
  ).toBe(1);
  expect(
    findSearchTargetIndex(matches, {
      query: "needle",
      activeIndex: 0,
      navigationId: 1,
      targetRunId: "other",
    }),
  ).toBe(-1);
});

it("falls back without logging source code when a parser rejects header-like hunk content", async () => {
  const { vi } = await import("vitest");
  const logged = vi.spyOn(console, "error").mockImplementation(() => {});
  try {
    const patch =
      "--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n--- private source\n+++ replacement\n keep\n";
    expect(patchFindTargets("file", "file.txt", patch).map((target) => target.text)).toEqual([
      "-- private source",
      "++ replacement",
      "keep",
    ]);
    patchFindTargets(
      "file",
      "file.txt",
      `${patch}\ndiff --git a/other b/other\n--- a/other\n+++ b/other\n@@ -1 +1 @@\n-old\n+new\n`,
    );
    expect(logged).not.toHaveBeenCalled();
  } finally {
    logged.mockRestore();
  }
});
