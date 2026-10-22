import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, test, vi } from "vitest";
import { ReviewDiffViewer } from "../src/components/ReviewDiffViewer.tsx";
import type { ReviewDiffData } from "../src/review-diff.ts";

const rendered = vi.hoisted(() => ({ rich: vi.fn(), patch: vi.fn() }));
vi.mock("@pierre/diffs/react", () => ({
  MultiFileDiff: (props: Record<string, unknown>) => {
    rendered.rich(props);
    return createElement("diffs-container");
  },
  PatchDiff: (props: Record<string, unknown>) => {
    rendered.patch(props);
    return createElement("diffs-container");
  },
}));
beforeEach(() => {
  rendered.rich.mockClear();
  rendered.patch.mockClear();
});
const diff: ReviewDiffData = {
  path: "main.java",
  availability: "patch",
  beforeContent: "class Old {}\n",
  afterContent: "class Next {}\n",
  patch: "--- a/main.java\n+++ b/main.java\n@@ -1 +1 @@\n-class Old {}\n+class Next {}\n",
  summary: null,
};
test("full snapshots use the reference rich viewer options and put theme variables on the actual shadow host", () => {
  renderToStaticMarkup(createElement(ReviewDiffViewer, { diff, id: "file" }));
  expect(rendered.patch).not.toHaveBeenCalled();
  expect(rendered.rich).toHaveBeenCalledWith(
    expect.objectContaining({
      oldFile: expect.objectContaining({ contents: diff.beforeContent }),
      newFile: expect.objectContaining({ contents: diff.afterContent }),
      options: expect.objectContaining({
        diffStyle: "unified",
        diffIndicators: "bars",
        disableFileHeader: true,
        hunkSeparators: "line-info",
        lineDiffType: "word-alt",
        overflow: "scroll",
        theme: { light: "github-light", dark: "github-dark" },
        preferredHighlighter: "shiki-wasm",
      }),
      style: expect.objectContaining({
        "--diffs-bg": "var(--color-bg)",
        "--diffs-font-size": "12px",
        "--diffs-font-family": "var(--font-code)",
      }),
    }),
  );
});
test("incomplete snapshots preserve their patch with simple separators and never fabricate a missing side", () => {
  renderToStaticMarkup(
    createElement(ReviewDiffViewer, {
      diff: { ...diff, beforeContent: null, afterContent: null },
      id: "file",
    }),
  );
  expect(rendered.rich).not.toHaveBeenCalled();
  expect(rendered.patch).toHaveBeenCalledWith(
    expect.objectContaining({
      patch: diff.patch,
      options: expect.objectContaining({ hunkSeparators: "simple" }),
    }),
  );
});
test("binary and oversized content show the reference fallback text", () => {
  expect(
    renderToStaticMarkup(
      createElement(ReviewDiffViewer, { diff: { ...diff, availability: "binary" }, id: "file" }),
    ),
  ).toContain("无法预览二进制 Diff");
  expect(
    renderToStaticMarkup(
      createElement(ReviewDiffViewer, { diff: { ...diff, availability: "truncated" }, id: "file" }),
    ),
  ).toContain("Diff 已裁剪");
  expect(rendered.rich).not.toHaveBeenCalled();
});
