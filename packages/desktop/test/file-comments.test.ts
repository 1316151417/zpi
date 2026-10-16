import { describe, expect, it } from "vitest";
import { buildSelectionPrompt } from "zpi-ui";
import {
  appendSelection,
  createFileComment,
  fileComments,
  normalizeFileCommentRange,
} from "../src/renderer/file-comments.ts";

describe("file preview line comments", () => {
  it("normalizes dragged and out-of-bounds selections", () => {
    expect(normalizeFileCommentRange({ start: 3, end: 1 }, "one\ntwo\nthree")).toEqual({ start: 1, end: 3 });
    expect(normalizeFileCommentRange({ start: -1, end: 99 }, "one\ntwo")).toEqual({ start: 1, end: 2 });
  });
  it("adds code, line range, path and optional comment to the existing composer context", () => {
    const selected = createFileComment(
      "src/main.ts",
      "first\nsecond\nthird",
      { start: 3, end: 2 },
      "  explain this  ",
      "test",
    );
    expect(selected.text).toBe("第 2–3 行\nsecond\nthird\n\n备注：explain this");
    expect(fileComments([selected], "src/main.ts")).toEqual([
      { id: "test", start: 2, end: 3, comment: "explain this" },
    ]);
    expect(buildSelectionPrompt("Review", [selected])).toContain('"path":"src/main.ts"');
    expect(buildSelectionPrompt("Review", [selected])).toContain("explain this");
    expect(fileComments([selected], "other.ts")).toEqual([]);
  });
  it("allows code-only context but rejects an empty code selection", () => {
    expect(createFileComment("a", "one\n", { start: 1, end: 1 }, "", "test").text).toBe("第 1 行\none");
    expect(() => createFileComment("a", "one\n", { start: 2, end: 2 }, "comment", "test")).toThrow(
      "请选择包含内容",
    );
  });
  it("respects existing context size limits and deduplicates repeated additions", () => {
    const ref = createFileComment("a", "one", { start: 1, end: 1 }, "", "test");
    expect(appendSelection([ref], { ...ref, id: "again" })).toEqual([ref]);
    expect(() =>
      appendSelection([], createFileComment("a", "x".repeat(8000), { start: 1, end: 1 }, "", "large")),
    ).toThrow("8,000");
  });
  it("ignores malformed and unrelated references", () => {
    expect(
      fileComments(
        [
          {
            text: "text",
            path: "a",
            id: "test",
            sourceKey: 'file-comment:{"start":0,"end":1,"comment":"bad"}',
          },
          { text: "normal", path: "a" },
          { text: "text", path: "a", id: "bad", sourceKey: "file-comment:{" },
        ],
        "a",
      ),
    ).toEqual([]);
  });
});

describe("preview breadcrumb", () => {
  it("shows workspace-relative parents and preserves outside-workspace roots", async () => {
    const { previewBreadcrumb } = await import("../src/renderer/preview-breadcrumb.ts");
    expect(previewBreadcrumb("/work/default/src/a.ts", "/work/default")).toEqual({
      root: "default",
      parents: ["src"],
      file: "a.ts",
    });
    expect(previewBreadcrumb("/tmp/a.ts", "/work/default")).toEqual({
      root: "/",
      parents: ["tmp"],
      file: "a.ts",
    });
    expect(previewBreadcrumb("C:\\project\\src\\a.ts", "C:\\project")).toEqual({
      root: "project",
      parents: ["src"],
      file: "a.ts",
    });
  });
});
