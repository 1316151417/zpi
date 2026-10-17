import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test, vi } from "vitest";
import { ToolBlock } from "../src/components/ToolBlock.tsx";
import { openWebToolLink, WebToolMarkdown } from "../src/components/WebToolBlock.tsx";
import { normalizeWebToolDetails, safeWebUrl, webToolLimits } from "../src/components/web-tool-data.ts";
import { emptySession, reduceSession } from "../src/reducer.ts";
import type { DesktopEvent, SessionView, ViewBlock, WebToolDetails } from "../src/types.ts";

const source = {
  title: "Article title",
  url: "https://example.com/article",
  snippet: "Source excerpt",
  site_name: "Example",
  site_icon: "https://example.com/favicon.ico",
  date: "2026-10-17",
};
const block: Extract<ViewBlock, { type: "tool" }> = {
  type: "tool",
  id: "b",
  messageId: "m",
  toolCallId: "call",
  name: "web_search",
  argsText: '{"query":"Search term"}',
  status: "completed",
  output: "Legacy text",
};
const render = (web: WebToolDetails, expanded = true) =>
  renderToStaticMarkup(
    createElement(ToolBlock, {
      block: { ...block, name: web.kind, web },
      expanded,
      toggle: () => {},
      onLink: () => {},
    }),
  );

test.each([
  ["pending", "进行中"],
  ["success", "1 个来源"],
  ["error", "执行失败"],
  ["cancelled", "已取消"],
] as const)("renders %s web status and preserves safe source details", (status, label) => {
  const markup = render({
    kind: "web_search",
    status,
    query: "Search term",
    results: status === "success" ? [source] : undefined,
    message: status === "error" ? "Service unavailable" : undefined,
  });
  expect(markup).toContain(label);
  expect(markup).toContain("Search term");
  if (status === "success") {
    expect(markup).toContain("Article title");
    expect(markup).toContain("Source excerpt");
    expect(markup).toContain("2026-10-17");
    expect(markup).toContain("网站图标占位");
    expect(markup).not.toContain("favicon.ico");
    expect(markup).not.toMatch(/<img\b/);
  }
});

test("fetch content is collapsible, bounded and marks truncation", () => {
  const web: WebToolDetails = {
    kind: "web_fetch",
    status: "success",
    url: source.url,
    title: "Fetched page",
    content: "# Heading\n\nUseful body",
    truncated: true,
  };
  expect(render(web)).toContain("Useful body");
  expect(render(web)).toContain("已截断显示");
  expect(render(web, false)).not.toContain("Useful body");
  expect(render(web, false)).toContain("Fetched page");
});

test("does not execute raw HTML or load remote images and only links HTTP(S)", () => {
  const markup = renderToStaticMarkup(
    createElement(WebToolMarkdown, {
      text: '# Safe heading\n\n<script>alert(1)</script>\n\n<img src="https://evil.example/pixel">\n\n![tracker](https://evil.example/track)\n\n[Local](file:///tmp/secret) [Script](javascript:alert(1)) [Good](https://example.com)\n\n```mermaid\ngraph TD; A-->B\n```',
      onLink: () => {},
    }),
  );
  expect(markup).toContain("Safe heading");
  expect(markup).not.toMatch(/<(?:script|img|iframe)\b/i);
  expect(markup).not.toContain("javascript:");
  expect(markup).not.toContain("file:///tmp");
  expect(markup).not.toContain('title="https://evil.example');
  expect(markup).toContain('title="https://example.com"');
  expect(markup).toContain("图片未加载");
  expect(markup).not.toContain("mermaid-block");
});

test.each([
  "file:///tmp/secret",
  "data:text/html,x",
  "javascript:alert(1)",
  "https://user:pass@example.com/",
  "https://example.com\\x",
  "//example.com",
  "http://example.com/\n",
])("blocks unsafe link routing: %s", (url) => {
  const onLink = vi.fn();
  openWebToolLink(url, onLink);
  expect(safeWebUrl(url)).toBeUndefined();
  expect(onLink).not.toHaveBeenCalled();
});

test("validates persisted metadata, bounds content and never shortens a URL into another destination", () => {
  expect(normalizeWebToolDetails({ kind: "web_search", status: "invalid" })).toBeUndefined();
  expect(normalizeWebToolDetails({ kind: "web_search", status: "success" }, "web_fetch")).toBeUndefined();
  const value = normalizeWebToolDetails({
    kind: "web_fetch",
    status: "success",
    content: "x".repeat(webToolLimits.content + 1),
    url: `https://example.com/${"a".repeat(8192)}`,
    password: "discard",
  });
  expect(value?.content).toHaveLength(webToolLimits.content);
  expect(value?.url).toBeUndefined();
  expect(value?.truncated).toBe(true);
  expect(value).not.toHaveProperty("password");
  const sources = normalizeWebToolDetails({
    kind: "web_search",
    status: "success",
    results: [...Array.from({ length: 50 }, () => source), { ...source, url: "javascript:alert(1)" }],
  });
  expect(sources?.results).toHaveLength(50);
  expect(sources?.truncated).toBe(true);
});

test("reducer persists pending and result metadata and turns interrupted web requests into cancellation", () => {
  let view: SessionView = {
    ...emptySession("s"),
    runs: [
      {
        runId: "r",
        status: "running" as const,
        userMessage: "",
        orderedBlocks: [{ ...block, status: "running" as const }],
        finalAnswerBlockIds: [],
        startedAt: 1,
      },
    ],
  };
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "r", seq: ++seq, event });
  };
  apply({
    type: "tool_update",
    toolCallId: "call",
    output: "Searching",
    web: { kind: "web_search", status: "pending", query: "Search term" },
  });
  apply({ type: "settled", status: "aborted", endedAt: 2 });
  expect(view.runs[0].orderedBlocks[0]).toMatchObject({ web: { status: "cancelled", query: "Search term" } });
});

test.each(["Tool cancelled before execution", "Tool cancelled before execution; effects unknown"])(
  "preflight cancellation is not shown as a service failure: %s",
  (output) => {
    let view: SessionView = {
      ...emptySession("s"),
      runs: [
        {
          runId: "r",
          status: "running",
          userMessage: "",
          orderedBlocks: [{ ...block, status: "preparing" }],
          finalAnswerBlockIds: [],
          startedAt: 1,
        },
      ],
    };
    view = reduceSession(view, {
      sessionId: "s",
      runId: "r",
      seq: 1,
      event: { type: "tool_end", toolCallId: "call", isError: true, output },
    });
    view = reduceSession(view, {
      sessionId: "s",
      runId: "r",
      seq: 2,
      event: { type: "settled", status: "aborted", endedAt: 2 },
    });
    const cancelled = view.runs[0].orderedBlocks[0];
    expect(cancelled).toMatchObject({ web: { status: "cancelled" } });
    if (cancelled.type !== "tool" || !cancelled.web) throw new Error("Expected web tool");
    expect(render(cancelled.web)).toContain("已取消");
  },
);

test("Unicode source URLs retain their original length across repeated history normalization", () => {
  const url = `https://example.com/${"汉".repeat(1000)}`;
  expect(new URL(url).href.length).toBeGreaterThan(8192);
  const first = normalizeWebToolDetails({
    kind: "web_search",
    status: "success",
    results: [{ ...source, url }],
  });
  expect(first?.results?.[0].url).toBe(url);
  expect(normalizeWebToolDetails(first)?.results?.[0].url).toBe(url);
});
