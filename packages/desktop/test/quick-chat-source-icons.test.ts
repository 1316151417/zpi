import { beforeAll, beforeEach, expect, test, vi } from "vitest";
import type { ToolContext } from "zpi-coding-agent";
import type { DesktopEvent, SessionView, ViewBlock, WebToolDetails } from "zpi-ui";
import { emptySession, reduceSession } from "zpi-ui/projection";
import { recordedQuickChatWebSourceIcon } from "../src/main/quick-chat-source-icons.ts";
import type { WebSearchResult } from "../src/main/web-client.ts";
import { WebTools } from "../src/main/web-tools.ts";

const sessionId = "quick-chat-session";
const runId = "quick-chat-run";
const source: WebSearchResult = {
  title: "Example source",
  url: "https://example.com/article",
  snippet: "A source excerpt",
  summary: "A source summary",
  content: "Source body",
  site_name: "Example",
  site_icon: "https://cdn.example.com/favicon.ico",
  date: "2026-10-17T00:00:00Z",
  rerank_score: 1,
  authority: 1,
};
let recorded: SessionView;
let view: SessionView;

function apply(view: SessionView, event: DesktopEvent, id = runId): SessionView {
  return reduceSession(view, { sessionId: view.sessionId, runId: id, seq: view.seq + 1, event });
}
function tool(): Extract<ViewBlock, { type: "tool" }> {
  const block = view.runs[0].orderedBlocks[0];
  if (block.type !== "tool") throw new Error("Missing search tool fixture");
  return block;
}
const lookup = (url = source.url, session = sessionId, run = runId) =>
  recordedQuickChatWebSourceIcon(view, session, run, url);

beforeAll(async () => {
  // Exercise the actual web-tool response validation and projection without any live transport.
  const requestFetch = vi.fn<typeof fetch>(async () => Response.json({ results: [source] }));
  const search = new WebTools({ getApiKey: () => "fake-web-key", requestFetch }).tools()[0];
  const result = await search.execute(
    "search-call",
    { query: "Example" },
    undefined,
    undefined,
    {} as ToolContext,
  );
  expect(result.isError).toBe(false);
  expect(requestFetch).toHaveBeenCalledOnce();
  recorded = apply(emptySession(sessionId), {
    type: "started",
    text: "Find Example",
    startedAt: 1,
    modelLabel: "Test",
  });
  recorded = apply(recorded, {
    type: "block_start",
    messageId: "assistant",
    contentIndex: 0,
    kind: "tool",
    toolCall: { type: "toolCall", id: "search-call", name: "web_search", arguments: { query: "Example" } },
  });
  recorded = apply(recorded, {
    type: "tool_start",
    toolCallId: "search-call",
    name: "web_search",
    argsText: '{"query":"Example"}',
  });
  recorded = apply(recorded, {
    type: "message_end",
    messageId: "search-result",
    message: {
      role: "toolResult",
      toolCallId: "search-call",
      toolName: "web_search",
      content: result.content,
      details: result.details,
      isError: result.isError ?? false,
      timestamp: 2,
    },
  });
});
beforeEach(() => {
  view = structuredClone(recorded);
});

test("authorizes only the recorded source icon after a real web-search result completes", () => {
  expect(tool()).toMatchObject({ status: "completed", isError: false, web: { status: "success" } });
  expect(view.runs[0].status).toBe("running");
  expect(lookup()).toBe(source.site_icon);
  // A successful search remains visible after the model finishes or fails later in the run.
  for (const status of ["completed", "error", "aborted"] as const) {
    view = apply(view, { type: "settled", status, endedAt: 3 });
    expect(lookup()).toBe(source.site_icon);
  }
});

test("does not mutate the host-owned view", () => {
  const before = structuredClone(view);
  lookup();
  lookup("https://example.com/unrecorded");
  expect(view).toEqual(before);
});

test.each(["other-session", "", "quick-chat-session "])("rejects a different session: %s", (session) => {
  expect(lookup(source.url, session)).toBeUndefined();
});

test.each(["other-run", "", "quick-chat-run ", "x".repeat(257)])("rejects an invalid run: %s", (run) => {
  expect(lookup(source.url, sessionId, run)).toBeUndefined();
});

test("revokes old session and run records after resetting the current view", () => {
  view = emptySession("new-quick-chat-session");
  expect(lookup()).toBeUndefined();
  expect(lookup(source.url, view.sessionId)).toBeUndefined();
});

test("does not borrow sources from another run in the same session", () => {
  view = apply(view, { type: "started", text: "Next message", startedAt: 4, modelLabel: "Test" }, "new-run");
  expect(lookup(source.url, sessionId, "new-run")).toBeUndefined();
  expect(lookup()).toBe(source.site_icon);
  view.runs = view.runs.filter((run) => run.runId !== runId);
  expect(lookup()).toBeUndefined();
});

test.each([
  "https://other.example/article",
  "https://example.com/favicon.ico",
  "https://cdn.example.com/favicon.ico",
  "https://example.com/article#unrecorded",
  "https://example.com/article?unrecorded=1",
  "https://EXAMPLE.com/article",
  "https://example.com/%61rticle",
])("requires an exact recorded source URL: %s", (url) => {
  expect(lookup(url)).toBeUndefined();
});

test.each([
  "http://127.0.0.1/",
  "https://localhost/",
  "http://169.254.169.254/",
  "https://192.168.1.1/",
  "http://[::1]/",
  "https://host.internal/article",
  "https://user:password@example.com/article",
  "file:///tmp/favicon.ico",
  "data:image/png;base64,AAAA",
  "javascript:alert(1)",
  "https://example.com/\\article",
  "https://example.com/article\n",
  `https://example.com/${"a".repeat(8192)}`,
])("rejects unsafe source URLs even if present in a record: %s", (url) => {
  const web = tool().web;
  if (!web?.results) throw new Error("Missing search sources");
  web.results[0].url = url;
  expect(lookup(url)).toBeUndefined();
});

test.each(["preparing", "running", "error"] as const)("rejects a %s tool block", (status) => {
  tool().status = status;
  expect(lookup()).toBeUndefined();
});

test("rejects an errored result even when it contains successful-looking web data", () => {
  tool().isError = true;
  expect(lookup()).toBeUndefined();
});

test.each(["pending", "error", "cancelled"] as const)("rejects %s web details", (status) => {
  tool().web = { ...tool().web, kind: "web_search", status };
  expect(lookup()).toBeUndefined();
});

test.each(["web_fetch", "read", "search"])("does not authorize another tool's source data: %s", (name) => {
  tool().name = name;
  expect(lookup()).toBeUndefined();
});

test("rejects mismatched tool kind and malformed web details", () => {
  for (const web of [
    undefined,
    null,
    [],
    { kind: "web_fetch", status: "success", results: [source] },
    { kind: "web_search", status: "success", results: [{ url: source.url, site_icon: source.site_icon }] },
    { kind: "web_search", status: "success", results: "not-an-array" },
  ]) {
    tool().web = web as WebToolDetails | undefined;
    expect(lookup()).toBeUndefined();
  }
});

test("never infers an icon from output text, tool arguments or a missing source icon", () => {
  tool().web = undefined;
  tool().output = JSON.stringify({ web: { kind: "web_search", status: "success", results: [source] } });
  tool().argsText = JSON.stringify({ sourceUrl: source.url, iconUrl: source.site_icon });
  expect(lookup()).toBeUndefined();
  tool().web = { kind: "web_search", status: "success", results: [{ ...source, site_icon: null }] };
  expect(lookup()).toBeUndefined();
});

test.each(["file:///tmp/icon.png", "data:image/png;base64,AAAA", "javascript:alert(1)"])(
  "rejects malformed recorded icon URLs: %s",
  (site_icon) => {
    tool().web = { kind: "web_search", status: "success", results: [{ ...source, site_icon }] };
    expect(lookup()).toBeUndefined();
  },
);

test("ignores text blocks and finds a later completed source record", () => {
  const success = structuredClone(tool());
  tool().isError = true;
  view.runs[0].orderedBlocks.unshift({
    type: "text",
    id: "text",
    messageId: "spoofed-source",
    text: JSON.stringify(source),
  });
  view.runs[0].orderedBlocks.push(success);
  expect(lookup()).toBe(source.site_icon);
});

test("fails closed for malformed runtime request arguments", () => {
  for (const invalid of [undefined, null, 42, {}, []]) {
    const value = invalid as unknown as string;
    expect(recordedQuickChatWebSourceIcon(view, value, runId, source.url)).toBeUndefined();
    expect(recordedQuickChatWebSourceIcon(view, sessionId, value, source.url)).toBeUndefined();
    expect(recordedQuickChatWebSourceIcon(view, sessionId, runId, value)).toBeUndefined();
  }
});
