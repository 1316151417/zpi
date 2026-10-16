import { type ComponentProps, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiffView } from "../src/components/DiffView.tsx";
import { useToolTokens } from "../src/components/ToolDiff.tsx";
import { useTextFind } from "../src/components/use-text-find.ts";

vi.mock("../src/components/use-text-find.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/use-text-find.ts")>()),
  useTextFind: vi.fn(),
}));

vi.mock("../src/components/ToolDiff.tsx", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/components/ToolDiff.tsx")>()),
  useToolTokens: vi.fn(),
}));

beforeEach(() => vi.mocked(useToolTokens).mockReset());

vi.mock("@pierre/diffs/react", () => ({
  PatchDiff: ({ options }: { options: Record<string, unknown> }) =>
    createElement("diffs-container", {
      "data-style": options.diffStyle,
      "data-overflow": options.overflow,
      "data-indicators": options.diffIndicators,
      "data-line-diff": options.lineDiffType,
      "data-hunks": options.hunkSeparators,
      "data-line-selection": String(options.enableLineSelection),
      "data-expanded": String(options.expandUnchanged),
      "data-find-css": options.unsafeCSS,
    }),
}));

const entry = {
  id: "change-1",
  path: "src/example.ts",
  area: "working",
  status: "modified",
  patch:
    "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old value\n+new value\n",
};

function render(overrides: Partial<ComponentProps<typeof DiffView>> = {}) {
  return renderToStaticMarkup(
    createElement(DiffView, {
      entries: [entry],
      loadPatch: async () => "",
      openFile: vi.fn(),
      ...overrides,
    }),
  );
}

describe("diff preview", () => {
  it("renders one shared header without duplicate file navigation or area and mode headings", () => {
    const openFile = vi.fn();
    const renderHeader = vi.fn((path: string, _openFile: () => void) => createElement("header", null, path));
    const html = render({ renderHeader, openFile });
    expect(html).toContain("diff-single-file diff-preview");
    expect(html).toContain("<header>src/example.ts</header>");
    expect(html).not.toContain("<nav");
    expect(html).not.toContain("diff-mode");
    expect(html).not.toContain("diff-heading");
    expect(html).not.toContain("working");
    expect(html).not.toContain("打开文件");
    expect(html).toContain('data-style="unified"');
    expect(html).toContain('data-indicators="bars"');
    expect(html).toContain('data-line-diff="word-alt"');
    expect(html).toContain('data-hunks="simple"');
    expect(html).toContain('data-line-selection="false"');
    expect(html).toContain('data-overflow="scroll"');
    expect(renderHeader).toHaveBeenCalledOnce();
    renderHeader.mock.calls[0][1]();
    expect(openFile).toHaveBeenCalledWith(entry.id);
  });

  it("keeps generic mode controls and navigation between distinct paths", () => {
    const html = render({
      entries: [entry, { ...entry, id: "change-2", path: "src/other.ts" }],
      initialPath: "src/other.ts",
    });
    expect(html).toContain('<nav aria-label="改动文件">');
    expect(html).toContain('class="diff-mode"');
    expect(html).toContain('class="diff-heading"');
    expect(html).toContain("统一");
    expect(html).toContain("并排");
    expect(html).toContain('data-hunks="line-info"');
    expect(html).toContain('data-diff-id="change-2"');
    expect(html).not.toContain('data-diff-id="change-1"');
  });

  it("treats several entries for one path as a single file", () => {
    const html = render({ entries: [entry, { ...entry, id: "staged", area: "staged" }] });
    expect(html).not.toContain("<nav");
    expect(html).toContain('data-diff-id="change-1"');
    expect(html).toContain('data-diff-id="staged"');
  });

  it("preserves partial-failure notices and renamed-file context without area headings", () => {
    const html = render({
      entries: [{ ...entry, failed: true, oldPath: "old.ts", reason: "无法应用部分变更" }],
      renderHeader: () => createElement("header"),
    });
    expect(html).toContain("部分修改失败");
    expect(html).toContain("无法应用部分变更");
    expect(html).toContain("old.ts → src/example.ts");
    expect(html).not.toContain("diff-heading");
  });

  it("forwards wrapping and keeps find highlighting and searchable context", () => {
    const html = render({
      wrap: true,
      renderHeader: () => createElement("header"),
      findRequest: { query: "value", activeIndex: 0, navigationId: 1 },
    });
    expect(html).toContain("diff-wrap");
    expect(html).toContain('data-overflow="wrap"');
    expect(html).toContain('data-expanded="true"');
    expect(html).toContain("::highlight(zpi-changes-find)");
  });

  it("keeps large-patch fallback lines searchable and uses simple separators", () => {
    const patch = `${entry.patch}${" context value\n".repeat(1200)}`;
    const html = render({
      entries: [{ ...entry, patch }],
      wrap: true,
      renderHeader: () => createElement("header"),
    });
    expect(html).toContain('class="diff-plain"');
    expect(html).toContain('class="diff-hunk diff-hunk-simple"');
    expect(html).toContain('data-find-key="change-1:0">old value');
    expect(html).toContain('data-find-key="change-1:1">new value');
    expect(html).not.toContain("diff --git");
    expect(html).not.toContain("<diffs-container");
  });

  it.each([
    { kind: "added", old: "/dev/null", next: "notes.txt", range: "-0,0 +1,3", marker: "+" },
    { kind: "removed", old: "notes.txt", next: "/dev/null", range: "-1,3 +0,0", marker: "-" },
  ])("renders small $kind files using a single lightweight gutter", ({ kind, old, next, range, marker }) => {
    const patch = `--- ${old}\n+++ ${next}\n@@ ${range} @@\n${marker}first line\n${marker}\n${marker}last line\n`;
    const html = render({
      entries: [{ ...entry, patch }],
      renderHeader: () => createElement("header"),
    });
    expect(html).toContain("data-lightweight-diff-preview");
    expect(html).toContain(`class="tool-diff-line ${kind}"`);
    expect(html.match(/class="tool-diff-number"/g)).toHaveLength(3);
    expect(html).toContain('class="tool-diff-number" aria-hidden="true">1</span>');
    expect(html).toContain('class="tool-diff-number" aria-hidden="true">3</span>');
    expect(html).toContain('data-find-key="change-1:plain:3">first line');
    expect(html).toContain('data-find-key="change-1:plain:4"> </code>');
    expect(html).not.toContain("diff-hunk");
    expect(html).not.toContain("<diffs-container");
    expect(html).not.toContain(`${marker}first line`);
  });

  it("preserves header-like file content and matching find keys in lightweight previews", () => {
    const patch =
      "--- /dev/null\n+++ notes.txt\n@@ -0,0 +1,3 @@\n+++ real content\n+--- content\n+last line\n\\ No newline at end of file\n";
    const html = render({
      entries: [{ ...entry, patch }],
      renderHeader: () => createElement("header"),
      findRequest: { query: "content", activeIndex: 0, navigationId: 1 },
    });
    const targets = vi.mocked(useTextFind).mock.calls.at(-1)?.[0].targets;
    expect(targets?.map(({ key, text }) => ({ key, text }))).toEqual([
      { key: "change-1:plain:3", text: "++ real content" },
      { key: "change-1:plain:4", text: "--- content" },
      { key: "change-1:plain:5", text: "last line" },
    ]);
    for (const target of targets ?? []) expect(html).toContain(`data-find-key="${target.key}"`);
    expect(html).toContain("++ real content");
    expect(html).toContain("--- content");
    expect(html).not.toContain("No newline at end of file");
  });

  it("preserves the ordinary diff renderer for insertions into an existing file", () => {
    const html = render({
      entries: [{ ...entry, patch: "--- notes.txt\n+++ notes.txt\n@@ -3,0 +4 @@\n+new line\n" }],
      renderHeader: () => createElement("header"),
    });
    expect(html).toContain("<diffs-container");
    expect(html).not.toContain("data-lightweight-diff-preview");
  });

  it("applies lightweight wrapping without adding annotation targets", () => {
    const html = render({
      entries: [{ ...entry, patch: "--- /dev/null\n+++ notes.txt\n@@ -0,0 +1 @@\n+long content\n" }],
      renderHeader: () => createElement("header"),
      wrap: true,
    });
    expect(html).toContain("diff-preview diff-wrap");
    expect(html).toContain('class="diff-lightweight-code"');
    expect(html).not.toContain("data-conversation-selectable");
    expect(html).not.toContain("data-selection-key");
  });

  it.each([
    { old: "/dev/null", next: "demo.ts", range: "-0,0 +1,3", marker: "+" },
    { old: "demo.ts", next: "/dev/null", range: "-1,3 +0,0", marker: "-" },
  ])(
    "renders asynchronous tokens in lightweight $marker lines without changing find keys",
    ({ old, next, range, marker }) => {
      vi.mocked(useToolTokens).mockReturnValue([
        [{ content: "const value = 1;", offset: 0, color: "#112233" }],
        [],
        [{ content: "value;", offset: 17, color: "#445566" }],
      ]);
      const patch = `--- ${old}\n+++ ${next}\n@@ ${range} @@\n${marker}const value = 1;\n${marker}\n${marker}value;\n`;
      const html = render({
        entries: [{ ...entry, patch }],
        renderHeader: () => createElement("header"),
      });
      expect(useToolTokens).toHaveBeenCalledWith("const value = 1;\n\nvalue;", "typescript");
      expect(html).toContain('data-lightweight-diff-highlight-language="typescript"');
      expect(html).toContain('data-lightweight-diff-highlighted="true"');
      expect(html).toContain('data-find-key="change-1:plain:3"><span style="color:#112233">const value = 1;');
      expect(html).toContain('data-find-key="change-1:plain:4"> </code>');
      expect(html).toContain('data-find-key="change-1:plain:5"><span style="color:#445566">value;');
      expect(html).not.toContain(`${marker}const value`);
    },
  );

  it("shows the empty state without an empty navigation region", () => {
    const html = render({ entries: [] });
    expect(html).toContain("暂无文件变更");
    expect(html).not.toContain("<nav");
  });
});
