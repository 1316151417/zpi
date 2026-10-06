import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChangedFiles } from "../src/components/ChangedFiles.tsx";
import type { FileChangeSummary, RunView } from "../src/types.ts";

function runWithChanges(changes: FileChangeSummary[]): RunView {
  return {
    runId: "run",
    userMessage: "修改文件",
    status: "completed",
    startedAt: 0,
    finalAnswerBlockIds: [],
    orderedBlocks: changes.map((fileChange, index) => ({
      id: `block-${index}`,
      messageId: "message",
      type: "tool",
      toolCallId: `call-${index}`,
      name: "edit",
      argsText: "{}",
      status: fileChange.failed ? "error" : "completed",
      output: "",
      fileChange,
    })),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe("changed file summaries", () => {
  it("omits the card when there are no changed files", () => {
    expect(renderToStaticMarkup(createElement(ChangedFiles, { run: runWithChanges([]) }))).toBe("");
  });

  it("keeps unknown counts and partial failures visible instead of presenting incomplete totals", () => {
    vi.stubGlobal("document", { baseURI: "https://ZPI.test/" });
    const markup = renderToStaticMarkup(
      createElement(ChangedFiles, {
        run: runWithChanges([
          { path: "/project/src/demo.txt", additions: 2, deletions: 1 },
          { path: "/project/src/demo.txt", failed: true },
          { path: "/project/test/demo.txt", additions: 3, deletions: 0 },
        ]),
        cwd: "/project",
      }),
    );
    expect(markup).toContain("2 个文件");
    expect(markup).toContain("行数未完整统计");
    expect(markup).toContain("无法统计行数");
    expect(markup).toContain('aria-label="部分修改失败"');
    expect(markup).toContain('class="changed-file-note">部分修改失败');
    expect(markup).toContain('class="changed-file-directory">src');
    expect(markup).toContain('class="changed-file-directory">test');
    expect(markup).not.toContain("+5");
  });
});
