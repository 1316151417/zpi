import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ToolBlock } from "../src/components/ToolBlock.tsx";
import { toolInputPreview } from "../src/components/tool-input-preview.ts";
import { type ToolView, toolCommand, toolFile } from "../src/components/tool-presentation.ts";
import { emptySession, reduceSession } from "../src/reducer.ts";
import type { DesktopEvent } from "../src/types.ts";

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

  it("keeps nested JSON escapes stable at every streaming boundary", () => {
    const content = JSON.stringify(
      { searches: [{ summary: "# 数智周报\n\n2026.10.17 02:34\n## 观点\n人工智能投资" }] },
      null,
      2,
    );
    const raw = JSON.stringify({ path: "ai-news.json", content });
    let previous = "";
    for (let end = 1; end <= raw.length; end++) {
      const preview = toolInputPreview(tool(raw.slice(0, end)))?.content;
      if (typeof preview !== "string") continue;
      expect(content.startsWith(preview), `invalid content at offset ${end}`).toBe(true);
      expect(preview.startsWith(previous), `rewritten prefix at offset ${end}`).toBe(true);
      previous = preview;
    }
    expect(previous).toBe(content);
  });

  it.each(["\\", "\\\\", "\\u", "\\u4", "\\u4e", "\\u4e2", "\\u4e2d", "\\n", "\\r", "\\t"])(
    "preserves literal escapes in %j at every streaming boundary",
    (content) => {
      const raw = JSON.stringify({ content });
      let previous = "";
      for (let end = 1; end <= raw.length; end++) {
        const preview = toolInputPreview(tool(raw.slice(0, end)))?.content;
        if (typeof preview !== "string") continue;
        expect(content.startsWith(preview), `invalid content at offset ${end}`).toBe(true);
        expect(preview.startsWith(previous), `rewritten prefix at offset ${end}`).toBe(true);
        previous = preview;
      }
      expect(previous).toBe(content);
    },
  );

  it.each([
    'line\n\tquoted "text"\rend',
    "中文😀\b\f",
    ...Array.from({ length: 8 }, (_, i) => `${"\\".repeat(i + 1)}\n\t\r"中文`),
    ...Array.from({ length: 8 }, (_, i) => `${"\\".repeat(i + 1)}u4e2d`),
  ])("decodes actual control characters, quotes and slash runs in %j", (content) => {
    // Exercise providers that emit Unicode escapes as well as literal UTF-16.
    for (const raw of [
      JSON.stringify({ content }),
      JSON.stringify({ content }).replace(/中/g, "\\u4e2d").replace(/文/g, "\\u6587"),
    ]) {
      let previous = "";
      for (let end = 1; end <= raw.length; end++) {
        const preview = toolInputPreview(tool(raw.slice(0, end)))?.content;
        if (typeof preview !== "string") continue;
        expect(content.startsWith(preview), `invalid content at offset ${end}`).toBe(true);
        expect(preview.startsWith(previous), `rewritten prefix at offset ${end}`).toBe(true);
        previous = preview;
      }
      expect(previous).toBe(content);
    }
  });

  it("keeps the reducer-to-component preview stable when a chunk ends on an escaped slash", () => {
    const content = JSON.stringify({ summary: "## 观点\n新闻正文\n第二段\t中文" }, null, 2);
    const args = JSON.stringify({ path: "ai-news.json", content });
    const boundary = args.indexOf("\\\\n", args.indexOf("新闻正文")) + 2;
    let view = emptySession("s");
    let seq = 0;
    const apply = (event: DesktopEvent) => {
      view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
    };
    apply({ type: "started", text: "write", startedAt: 1, modelLabel: "fake" });
    apply({
      type: "block_start",
      messageId: "m",
      contentIndex: 0,
      kind: "tool",
      toolCall: { type: "toolCall", id: "w", name: "write", arguments: {} },
    });
    apply({ type: "block_delta", messageId: "m", contentIndex: 0, delta: args.slice(0, boundary) });
    const before = view.runs[0].orderedBlocks[0];
    if (before.type !== "tool") throw new Error("Expected write block");
    const preview = toolInputPreview(before)?.content;
    expect(typeof preview).toBe("string");
    expect(content.startsWith(preview as string)).toBe(true);
    const html = render(before);
    expect(html).toContain("tool-content-preview");
    expect(html).toContain("观点\\n新闻正文");
    expect(html).not.toContain("观点\\\n新闻正文");
    apply({ type: "block_delta", messageId: "m", contentIndex: 0, delta: args.slice(boundary) });
    const after = view.runs[0].orderedBlocks[0];
    if (after.type !== "tool") throw new Error("Expected write block");
    expect(toolInputPreview(after)?.content).toBe(content);
    expect(toolInputPreview(before)?.content).toBe(preview);
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
  it("shows an empty write preview once the content field starts streaming", () => {
    const html = render(tool('{"path":"src/a.ts","content":"'));
    expect(html).not.toContain("Parameters");
    expect(html).toContain("tool-content-preview");
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
