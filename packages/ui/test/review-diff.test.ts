import { createTwoFilesPatch } from "diff";
import { expect, test } from "vitest";
import { getGitPaneDiffPreviewPlan, type ReviewDiffData } from "../src/review-diff.ts";
import { reviewFindTargets } from "../src/review-find.ts";

function data(path: string, beforeContent: string, afterContent: string): ReviewDiffData {
  return {
    path,
    availability: "patch",
    patch: createTwoFilesPatch(path, path, beforeContent, afterContent),
    beforeContent,
    afterContent,
    summary: null,
  };
}
test("normal modifications use full-content rendering with collapsed context, including unchanged search targets", () => {
  const before = `${Array.from({ length: 120 }, (_, i) => `Line${i + 1}`).join("\n")}\n`;
  const diff = data(
    "ResetTest.java",
    before,
    before
      .replace("Line19\n", "Changed19\n")
      .replace("Line41\n", "Changed41\n")
      .replace("Line63\n", "Changed63\n"),
  );
  expect(getGitPaneDiffPreviewPlan(diff)).toEqual({ kind: "rich" });
  const targets = reviewFindTargets("file", diff);
  expect(targets[0]).toMatchObject({ key: "file:0", text: "Line1" });
  expect(targets.at(-1)?.text).toBe("Line120");
  expect(targets.find((target) => target.text === "Changed19")?.key).toBe("file:19");
});
test("full content and patch inputs follow ZCode's separate render paths", () => {
  const diff = data("index.ts", "const old = 1;\n", "const next = 2;\n");
  expect(getGitPaneDiffPreviewPlan(diff)).toEqual({ kind: "rich" });
  expect(getGitPaneDiffPreviewPlan({ ...diff, beforeContent: null, afterContent: null })).toEqual({
    kind: "patch",
  });
  expect(getGitPaneDiffPreviewPlan(data("index.ts", "", "export const value = 1;\n"))).toEqual({
    kind: "rich",
  });
});
test.each([true, false])(
  "keeps structured files rich when diff headers have timestamps (created: %s)",
  (created) => {
    const diff = data("index.ts", created ? "" : "export {};\n", created ? "export {};\n" : "");
    diff.patch = createTwoFilesPatch(
      created ? "/dev/null" : "index.ts",
      created ? "index.ts" : "/dev/null",
      diff.beforeContent ?? "",
      diff.afterContent ?? "",
      created ? undefined : "2026-10-23 00:00:00",
      created ? "2026-10-23 00:00:00" : undefined,
    );
    expect(getGitPaneDiffPreviewPlan(diff)).toEqual({ kind: "rich" });
  },
);
test.each(["pnpm-lock.yaml", "package-lock.json", "build.gradle", "config.zsh"])(
  "%s uses the reference lightweight fallback",
  (path) => {
    expect(getGitPaneDiffPreviewPlan(data(path, "old\n", "next\n"))).toMatchObject({
      kind: "plain-text",
      lines: ["-old", "+next"],
    });
  },
);
test("deep hunks and large fallback previews keep the reference 800-line bound and protocol-free text", () => {
  const before = `${"old\n".repeat(1500)}end\n`;
  const diff = data("index.ts", before, before.replace("end", "changed"));
  expect(getGitPaneDiffPreviewPlan(diff).kind).toBe("plain-text");
  const large = getGitPaneDiffPreviewPlan(data("big.txt", "", `${"new\n".repeat(1600)}`));
  expect(large.kind).toBe("plain-text");
  if (large.kind === "plain-text") expect(large.lines.length).toBeLessThanOrEqual(800);
  expect(reviewFindTargets("file", diff).some((target) => target.text.startsWith("@@"))).toBe(false);
});

test("full-content find follows before/after order and counts unchanged text in both snapshots like ZCode", () => {
  const diff = data("file.ts", "unchanged\nbefore\n", "unchanged\nafter\n");
  expect(reviewFindTargets("file", diff).map(({ key, text }) => [key, text])).toEqual([
    ["file:0", "unchanged"],
    ["file:1", "before"],
    ["file:0", "unchanged"],
    ["file:2", "after"],
  ]);
});

test("patch-only find maps identical context lines by coordinates rather than collapsing them onto one row", () => {
  const repeated = `// ${"x".repeat(190)}\n`;
  const diff = data(
    "file.ts",
    `const value = 0;\n${repeated.repeat(1000)}`,
    `const value = 1;\n${repeated.repeat(1000)}`,
  );
  expect(getGitPaneDiffPreviewPlan(diff).kind).toBe("patch");
  const targets = reviewFindTargets("file", diff);
  expect(targets[1].key).toBe("file:2");
  expect(targets[2].key).toBe("file:3");
  expect(targets[1002].key).toBe("file:2");
  expect(targets[10].key).toContain(":hidden:");
});
