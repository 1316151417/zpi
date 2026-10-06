import { describe, expect, it } from "vitest";
import { buildFindMatches, findKeyDirection, moveFindIndex } from "../src/find.ts";
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
