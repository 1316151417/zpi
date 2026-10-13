import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolBlock } from "../src/components/ToolBlock.tsx";
import { toolInputPreview } from "../src/components/tool-input-preview.ts";
import { type ToolView, toolCommand, toolFile } from "../src/components/tool-presentation.ts";

// File icon URLs need the document base even during this server-rendered component test.
beforeAll(() => vi.stubGlobal("document", { baseURI: "http://localhost/" }));
afterAll(() => vi.unstubAllGlobals());

const tool = (argsText: string, overrides: Partial<ToolView> = {}): ToolView => ({
  id: "write",
  messageId: "message",
  type: "tool",
  toolCallId: "write",
  name: "write",
  argsText,
  status: "preparing",
  output: "",
  ...overrides,
});
const render = (block: ToolView, expanded = true) =>
  renderToStaticMarkup(createElement(ToolBlock, { block, expanded, toggle: () => {} }));

describe("ZCode streaming tool input preview", () => {
  it("shares completed parsing across presentation readers and invalidates when arguments change", () => {
    const block = tool('{"path":"a.ts","command":"rg old"}', { name: "bash" });
    const parse = vi.spyOn(JSON, "parse");
    try {
      const before = parse.mock.calls.length;
      expect(toolCommand(block)).toBe("rg old");
      expect(toolFile(block)?.path).toBe("a.ts");
      expect(toolInputPreview(block)?.command).toBe("rg old");
      expect(parse.mock.calls.length - before).toBe(1);
      block.argsText = '{"path":"b.ts","command":"rg new"}';
      expect(toolFile(block)?.path).toBe("b.ts");
      expect(toolCommand(block)).toBe("rg new");
    } finally {
      parse.mockRestore();
    }
  });

  it("does not use a cached partial command for grouping and respects status-only transitions", () => {
    const block = tool('{"command":"rg partial', { name: "bash" });
    expect(toolInputPreview(block)?.command).toBe("rg partial");
    expect(toolCommand(block)).toBe("");
    block.argsText += '"}';
    expect(toolCommand(block)).toBe("rg partial");
    block.argsText = "{}";
    expect(toolInputPreview(block)).toBeUndefined();
    block.status = "running";
    expect(toolInputPreview(block)).toEqual({});
  });

  it.each(["", "{", "{}", '{"path":', '{"unknown":"unfinished'])(
    "does not invent an empty Parameters object from %j",
    (raw) => {
      expect(toolInputPreview(tool(raw))).toBeUndefined();
      expect(render(tool(raw))).not.toContain("tool-parameters");
    },
  );

  it("retains a real empty argument object once the tool starts", () => {
    const block = tool("{}", { status: "running" });
    expect(toolInputPreview(block)).toEqual({});
    expect(render(block)).toContain("Parameters");
    expect(render(block)).toContain("{}");
  });

  it.each([
    ['{"path":"src/a.ts","content":"hello', { path: "src/a.ts", content: "hello" }],
    ['{"path":"C:\\\\project\\\\a.ts', { path: "C:\\project\\a.ts" }],
    ['{"content":"line\\n\\t\\"quoted\\"', { content: 'line\n\t"quoted"' }],
    ['{"content":"hello\\', { content: "hello" }],
    ['{"content":"hello\\u4e', { content: "hello" }],
    ['{"content":"\\u4e2d\\u6587', { content: "中文" }],
    ['{"path":"src/', { path: "src/" }],
  ])("recovers existing string fields from incomplete JSON: %s", (raw, input) => {
    expect(toolInputPreview(tool(raw))).toEqual(input);
  });

  it("preserves all fields and edit arrays when JSON is complete", () => {
    const input = { path: "src/a.ts", edits: [{ oldText: "before", newText: "after" }], timeout: 3 };
    expect(toolInputPreview(tool(JSON.stringify(input), { name: "edit" }))).toEqual(input);
  });

  it("uses streamed paths for the same file chip before content is complete", () => {
    expect(toolFile(tool('{"path":"/project/src/a.ts","content":"hello'), "/project")).toEqual({
      path: "/project/src/a.ts",
      name: "a.ts",
      directory: "src/",
    });
  });
});

describe("Parameters visibility", () => {
  it("shows nonempty input only when there is no content or patch preview", () => {
    const html = render(tool('{"path":"src/a.ts","content":"'));
    expect(html).toContain("Parameters");
    expect(html).toContain("src/a.ts");
    expect(html).not.toContain("tool-content-preview");
  });

  it.each(["preparing", "running", "completed", "error"] as const)(
    "replaces raw write parameters with a code preview in %s state",
    (status) => {
      const args = '{"path":"src/a.ts","content":"const a = 1;\\n';
      const html = render(tool(status === "preparing" ? args : `${args}"}`, { status }));
      expect(html).not.toContain("tool-parameters");
      expect(html).toContain("tool-content-preview");
      expect(html).toContain('data-language="typescript"');
      expect(html).toContain("const a = 1;");
    },
  );

  it("renders Markdown write content instead of JSON-escaped prose", () => {
    const html = render(tool('{"path":"notes.md","content":"# Title\\n\\n**Hello**'));
    expect(html).toContain("tool-markdown-preview");
    expect(html).toMatch(/<h1\b[^>]*>Title<\/h1>/);
    expect(html).toContain("<strong>Hello</strong>");
    expect(html).not.toContain("Parameters");
  });

  it("keeps the actual per-operation patch ahead of input content", () => {
    const html = render(
      tool('{"path":"a.ts","content":"input-preview"}', {
        status: "completed",
        fileChange: { path: "a.ts", patch: "@@ -1 +1 @@\n-old\n+actual-change" },
      }),
    );
    expect(html).toContain("actual-change");
    expect(html).not.toContain("input-preview");
    expect(html).not.toContain("Parameters");
  });

  it("keeps failed edit parameters and error details without a file preview", () => {
    const html = render(
      tool('{"path":"a.ts","edits":[{"oldText":"missing","newText":"new"}]}', {
        name: "edit",
        status: "error",
        output: "Could not find oldText",
      }),
    );
    expect(html).toContain("Parameters");
    expect(html).toContain("missing");
    expect(html).toContain("tool-detail-error");
    expect(html).toContain("Could not find oldText");
  });

  it("does not open details automatically while input streams", () => {
    expect(render(tool('{"path":"a.ts","content":"hello'), false)).not.toContain("tool-file-details");
  });
});
