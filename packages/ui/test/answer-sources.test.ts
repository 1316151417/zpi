import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { AnswerSourceList, AnswerSources } from "../src/components/AnswerSources.tsx";
import {
  type AnswerSource,
  answerSourceIconLoader,
  answerSourceLimits,
  answerSourceSites,
  collectAnswerSources,
  createAnswerSourceIconLoader,
  openAnswerSource,
  safeSourceIconData,
} from "../src/components/answer-sources.ts";
import { RunGroup } from "../src/components/Conversation.tsx";
import { emptySession, mergeHistory, reduceSession } from "../src/reducer.ts";
import type { DesktopEvent, RunView, ViewBlock, WebSearchSource, WebToolDetails } from "../src/types.ts";

const source = (overrides: Partial<WebSearchSource> = {}): WebSearchSource => ({
  url: "https://example.com/article",
  title: "Article title",
  snippet: "Source excerpt",
  summary: "Secondary summary",
  site_name: "Example",
  site_icon: "https://example.com/favicon.ico",
  date: "2026-10-17",
  ...overrides,
});
const answer = (id = "answer", messageId = id): ViewBlock => ({
  id,
  messageId,
  type: "text",
  text: "The answer",
});
const tool = (
  id = "search",
  web: WebToolDetails = { kind: "web_search", status: "success", results: [source()] },
): Extract<ViewBlock, { type: "tool" }> => ({
  id,
  messageId: `${id}-message`,
  type: "tool",
  toolCallId: `${id}-call`,
  name: web.kind,
  argsText: "{}",
  status: "completed",
  output: "MODEL_OUTPUT_MUST_STAY_UNCHANGED",
  web,
});
const run = (orderedBlocks: ViewBlock[], runId = "run"): RunView => ({
  runId,
  orderedBlocks,
  status: "completed",
  userMessage: "Question",
  finalAnswerBlockIds: orderedBlocks.filter((block) => block.type === "text").map((block) => block.id),
  startedAt: 1,
});
const collect = (blocks: ViewBlock[]) => collectAnswerSources(run([...blocks, answer()]), "answer");

test("decodes source entities once in search snippets and fetch excerpts", () => {
  const sources = collect([
    tool("search", {
      kind: "web_search",
      status: "success",
      results: [source({ title: "A &amp; B", snippet: "One &amp; two &lt;three&gt;" })],
    }),
    tool("fetch", {
      kind: "web_fetch",
      status: "success",
      url: "https://fetch.example/",
      content: "<p>Fish &amp; chips &amp;lt;tag&amp;gt;</p>",
    }),
  ]);
  expect(sources[0]).toMatchObject({ title: "A & B", excerpt: "One & two <three>" });
  expect(sources[1].excerpt).toBe("Fish & chips &lt;tag&gt;");
});
const png =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6i0AAAAASUVORK5CYII=";
const iconSource = (index = 0): AnswerSource => ({
  url: `https://example.com/${index}`,
  hostname: "example.com",
  title: "Title",
  siteName: "Example",
  siteIcon: "https://example.com/favicon.ico",
});
const renderList = (sources: AnswerSource[]) =>
  renderToStaticMarkup(createElement(AnswerSourceList, { sources, runId: "run", onLink: vi.fn() }));

test("deduplicates exact URLs across search, fetch and retries while enriching missing metadata", () => {
  const sources = collect([
    tool("fetch-first", { kind: "web_fetch", status: "success", url: source().url, content: "BODY" }),
    tool("search-first", {
      kind: "web_search",
      status: "success",
      results: [source({ snippet: "", site_name: null, site_icon: null, date: null })],
    }),
    tool("retry", {
      kind: "web_search",
      status: "success",
      results: [source(), source({ url: "https://example.com/other", title: "Other page" })],
    }),
    tool("fetch-after", { kind: "web_fetch", status: "success", url: source().url, title: "New title" }),
  ]);
  expect(sources).toHaveLength(2);
  expect(sources[0]).toEqual({
    url: source().url,
    hostname: "example.com",
    title: "Article title",
    siteName: "Example",
    siteIcon: source().site_icon,
    date: source().date,
    excerpt: "Source excerpt",
  });
  expect(sources[1].url).toBe("https://example.com/other");
  expect(answerSourceSites(sources)).toHaveLength(1);
});

test("keeps fifty source pages and at most five hostname icons in first-source order", () => {
  const results = Array.from({ length: 50 }, (_, index) =>
    source({ url: `https://site${Math.floor(index / 2)}.example/page${index}` }),
  );
  const sources = collect([tool("search", { kind: "web_search", status: "success", results })]);
  expect(sources).toHaveLength(50);
  expect(sources.map((entry) => entry.url)).toEqual(results.map((entry) => entry.url));
  expect(answerSourceSites(sources).map((entry) => entry.hostname)).toEqual([
    "site0.example",
    "site1.example",
    "site2.example",
    "site3.example",
    "site4.example",
  ]);
  const markup = renderList(sources);
  expect(markup.match(/class="answer-source-item"/g)).toHaveLength(50);
});

test("a later valid icon enriches the site's original position without adding a sixth globe", () => {
  const sources = collect([
    tool("search", {
      kind: "web_search",
      status: "success",
      results: [
        source({ site_icon: null }),
        ...Array.from({ length: 6 }, (_, index) => source({ url: `https://site${index}.example/` })),
        source({ url: "https://example.com/another" }),
      ],
    }),
  ]);
  const sites = answerSourceSites(sources);
  expect(sites).toHaveLength(5);
  expect(sites[0].url).toBe("https://example.com/another");
  const html = renderToStaticMarkup(createElement(AnswerSources, { sources, runId: "r", onLink: vi.fn() }));
  expect(html.match(/class="answer-source-icon"/g)).toHaveLength(5);
  expect(html.match(/lucide-globe/g)).toHaveLength(5);
  expect(html).not.toContain("<img");
  expect(html).not.toContain("favicon.ico");
});

test("requires successful completed web tools, excludes failures and legacy prose-only results", () => {
  const valid = tool();
  const web = valid.web as WebToolDetails;
  const variants = [
    { ...valid, status: "preparing" as const },
    { ...valid, status: "running" as const },
    { ...valid, status: "error" as const },
    { ...valid, isError: true },
    { ...valid, web: { ...web, status: "pending" as const } },
    { ...valid, web: { ...web, status: "cancelled" as const } },
    { ...valid, web: { ...web, status: "error" as const } },
    { ...valid, name: "subagent" },
    { ...valid, web: undefined, output: JSON.stringify({ results: [source()] }) },
  ];
  for (const variant of variants) expect(collect([variant])).toEqual([]);
  expect(collect([variants[0], valid])).toHaveLength(1);
});

test("an explicit answer message boundary excludes later results and same-message tool calls", () => {
  const first = tool("first", { kind: "web_fetch", status: "success", url: "https://first.example/" });
  const later = tool("later");
  const sameMessage = { ...tool("same"), messageId: "second-answer" };
  const view = run([first, answer("first-answer"), later, sameMessage, answer("second-answer")]);
  expect(collectAnswerSources(view, "first-answer").map((entry) => entry.url)).toEqual([
    "https://first.example/",
  ]);
  expect(collectAnswerSources(view, "second-answer").map((entry) => entry.url)).toEqual([
    "https://first.example/",
    source().url,
  ]);
  expect(collectAnswerSources(view)).toEqual([]);
  expect(collectAnswerSources(view, "missing")).toEqual([]);
  expect(collectAnswerSources(view, "first")).toEqual([]);
});

test("caps snippets, prefers snippet to summary, and keeps huge model output and page bodies out of the DOM", () => {
  const huge = "FULL_BODY_NEVER_RENDERED".repeat(100_000);
  const fetch = tool("fetch", {
    kind: "web_fetch",
    status: "success",
    url: "https://fetch.example/",
    content: `A concise introduction.\n\n\`\`\`text\n${huge}\n\`\`\``,
  });
  Object.defineProperty(fetch, "output", {
    get: () => {
      throw new Error("Read model output");
    },
  });
  const sources = collect([
    fetch,
    tool("search", {
      kind: "web_search",
      status: "success",
      results: [
        source({ snippet: "🙂".repeat(5000), summary: "Do not choose this" }),
        source({ url: "https://summary.example/", snippet: " \n ", summary: "Summary fallback" }),
        source({ url: "https://empty.example/", snippet: "", summary: "" }),
      ],
    }),
  ]);
  expect(sources[0]).toMatchObject({
    title: "https://fetch.example/",
    siteName: "fetch.example",
    excerpt: "A concise introduction.",
  });
  expect(Array.from(sources[1].excerpt ?? "")).toHaveLength(answerSourceLimits.excerpt);
  expect(sources[1].excerpt).toMatch(/…$/);
  expect(sources[2].excerpt).toBe("Summary fallback");
  expect(sources[3].excerpt).toBeUndefined();
  expect(renderList(sources)).not.toContain("FULL_BODY_NEVER_RENDERED");
  expect(renderList(sources).length).toBeLessThan(8000);
});

test("fetch-only excerpts use a bounded plain-text prefix, stripping markup and link destinations", () => {
  const content =
    `# Heading\n\nThe **latest** [research](https://hidden.example/report) &amp; findings.\n\n` +
    `<p>Useful <em>details</em>.</p><script>HIDDEN_SCRIPT</script><style>HIDDEN_STYLE</style>\n` +
    `![image](https://hidden.example/image.png)\n[Reference][ref]\n[ref]: https://hidden.example/reference\n` +
    `\n\`\`\`js\nHIDDEN_CODE\n\`\`\`\n` +
    "ordinary content ".repeat(1000) +
    "BODY_TAIL_NEVER_RENDERED";
  const block = tool("fetch", {
    kind: "web_fetch",
    status: "success",
    url: source().url,
    title: "Fetched title",
    content,
  });
  const before = JSON.stringify(block);
  const sources = collect([block]);
  expect(sources[0].excerpt).toContain("Heading The latest research & findings. Useful details.");
  expect(Array.from(sources[0].excerpt ?? "")).toHaveLength(answerSourceLimits.excerpt);
  const html = renderList(sources);
  expect(html).not.toMatch(/HIDDEN_SCRIPT|HIDDEN_STYLE|HIDDEN_CODE|BODY_TAIL_NEVER_RENDERED|hidden\.example/);
  expect(html).not.toMatch(/<(?:script|style|p|em|h1|img)\b/);
  expect(JSON.stringify(block)).toBe(before);
  const search = tool("search", {
    kind: "web_search",
    status: "success",
    results: [source({ snippet: "", summary: "Preferred search summary" })],
  });
  expect(collect([block, search])[0].excerpt).toBe("Preferred search summary");
  expect(collect([search, block])[0].excerpt).toBe("Preferred search summary");
});

test.each([
  undefined,
  "",
  " \n\t ",
  "<script>hidden</script>",
  "```js\nhidden\n```",
  "![image](https://hidden.example/image.png)",
])("fetch-only content without a usable excerpt %# leaves the snippet absent", (content) => {
  const sources = collect([
    tool("fetch", { kind: "web_fetch", status: "success", url: source().url, content }),
  ]);
  expect(sources).toHaveLength(1);
  expect(sources[0].excerpt).toBeUndefined();
  expect(renderList(sources)).not.toContain("answer-source-excerpt");
});

test.each([
  "javascript:alert(1)",
  "data:text/html,hello",
  "file:///tmp/private",
  "//example.com",
  "https://user:pass@example.com/",
  "https://example.com\\private",
  "https://example.com/\n",
])("excludes unsafe URL %s and revalidates it before opening", (url) => {
  expect(
    collect([tool("search", { kind: "web_search", status: "success", results: [source({ url })] })]),
  ).toEqual([]);
  expect(collect([tool("fetch", { kind: "web_fetch", status: "success", url })])).toEqual([]);
  const onLink = vi.fn();
  expect(openAnswerSource(url, onLink)).toBe(false);
  expect(onLink).not.toHaveBeenCalled();
});

test("safe source clicks always explicitly use the in-app browser", () => {
  const onLink = vi.fn();
  expect(openAnswerSource(source().url, onLink)).toBe(true);
  expect(onLink).toHaveBeenCalledWith(source().url, { forceInApp: true });
});

test("untrusted title, site, date and excerpt stay text, with no remote images or HTML execution", () => {
  const malicious = '<img src="https://tracker.example/" onerror="alert(1)"><script>evil()</script>';
  const sources = collect([
    tool("search", {
      kind: "web_search",
      status: "success",
      results: [
        source({
          title: malicious,
          site_name: malicious,
          snippet: malicious,
          date: malicious,
          site_icon: "data:image/svg+xml,<svg onload='evil()'>",
        }),
      ],
    }),
  ]);
  const html = renderList(sources);
  expect(html).toContain("&lt;img");
  expect(html).not.toMatch(/<(?:img|script|iframe)\b/);
  expect(sources[0].siteIcon).toBeUndefined();
});

test("history reconstruction remains run-local across reset/merge, side chats, and repeated reads", () => {
  const original = emptySession("session");
  original.runs = Array.from({ length: 3 }, (_, index) =>
    run(
      [
        tool(`tool-${index}`, {
          kind: "web_search",
          status: "success",
          results: [source({ url: `https://round${index}.example/` })],
        }),
        answer(`answer-${index}`),
      ],
      `round-${index}`,
    ),
  );
  const before = JSON.stringify(original);
  let view = original;
  for (let seq = 1; seq <= 3; seq++) {
    view = reduceSession(emptySession("session"), {
      sessionId: "session",
      runId: "history",
      seq,
      event: { type: "history_reset", view: JSON.parse(JSON.stringify(view)) },
    });
    view = mergeHistory(emptySession("session"), view);
    for (const [index, current] of view.runs.entries()) {
      expect(collectAnswerSources(current, `answer-${index}`).map((entry) => entry.url)).toEqual([
        `https://round${index}.example/`,
      ]);
    }
  }
  expect(view.runs).toEqual(original.runs);
  expect(JSON.stringify(original)).toBe(before);
  expect(collectAnswerSources(run([answer()], "round-0"), "answer")).toEqual([]);
});

test("source projection does not mutate frozen metadata or add transcript icon data", () => {
  const result = source();
  Object.freeze(result);
  const block = tool(
    "search",
    Object.freeze({
      kind: "web_search",
      status: "success",
      results: Object.freeze([result]) as unknown as WebSearchSource[],
    }),
  );
  const current = run([Object.freeze(block), Object.freeze(answer())]);
  const before = JSON.stringify(current);
  expect(collectAnswerSources(current, "answer")).toHaveLength(1);
  expect(JSON.stringify(current)).toBe(before);
  expect(before).not.toContain("data:image");
});

test("message_reset removes old sources and a retry's later tool cannot enrich the earlier answer", () => {
  let view = { ...emptySession("s"), runs: [run([tool("old"), answer()])] };
  let seq = 0;
  const apply = (event: DesktopEvent) => {
    view = reduceSession(view, { sessionId: "s", runId: "run", seq: ++seq, event });
  };
  expect(collectAnswerSources(view.runs[0], "answer")).toHaveLength(1);
  apply({ type: "message_reset", messageId: "old-message" });
  expect(collectAnswerSources(view.runs[0], "answer")).toEqual([]);
  const call = { type: "toolCall" as const, id: "retry-call", name: "web_search", arguments: {} };
  apply({ type: "block_start", messageId: "retry", contentIndex: 0, kind: "tool", toolCall: call });
  apply({ type: "tool_start", toolCallId: call.id, name: call.name, argsText: "{}" });
  apply({
    type: "tool_end",
    toolCallId: call.id,
    isError: false,
    output: "RETRY_MODEL_OUTPUT",
    web: {
      kind: "web_search",
      status: "success",
      results: [source({ url: "https://retry.example/" })],
    },
  });
  expect(collectAnswerSources(view.runs[0], "answer")).toEqual([]);
  apply({ type: "block_start", messageId: "retry-answer", contentIndex: 0, kind: "text" });
  apply({ type: "block_delta", messageId: "retry-answer", contentIndex: 0, delta: "Retry answer" });
  apply({ type: "settled", status: "completed", endedAt: 2 });
  expect(collectAnswerSources(view.runs[0], "retry-answer:0").map((entry) => entry.url)).toEqual([
    "https://retry.example/",
  ]);
});

test("merging older pages adds only this run's preceding tools and preserves the latest final answer", () => {
  const prior = tool("prior", {
    kind: "web_fetch",
    status: "success",
    url: "https://prior.example/",
    content: "Earlier source excerpt",
  });
  const older = {
    ...emptySession("s"),
    runs: [
      run(
        [
          tool("unrelated", { kind: "web_fetch", status: "success", url: "https://unrelated.example/" }),
          answer("other-answer"),
        ],
        "other-run",
      ),
      run([prior], "split-run"),
    ],
  };
  const newer = {
    ...emptySession("s"),
    runs: [{ ...run([answer()], "split-run"), historyContinuation: true }],
  };
  expect(collectAnswerSources(newer.runs[0], "answer")).toEqual([]);
  const before = JSON.stringify({ older, newer });
  const merged = mergeHistory(older, newer);
  const restored = merged.runs.find((entry) => entry.runId === "split-run");
  if (!restored) throw new Error("Missing merged run");
  expect(restored.finalAnswerBlockIds).toEqual(["answer"]);
  expect(collectAnswerSources(restored, "answer").map((entry) => entry.url)).toEqual([
    "https://prior.example/",
  ]);
  expect(JSON.stringify({ older, newer })).toBe(before);
});

test.each(["aborted", "interrupted"] as const)(
  "a %s round retains successful sources and excludes unfinished calls",
  (status) => {
    const pending = {
      ...tool("pending", {
        kind: "web_search",
        status: "pending",
        results: [source({ url: "https://pending.example/" })],
      }),
      status: "running" as const,
    };
    const view = {
      ...emptySession("s"),
      runs: [{ ...run([tool("finished"), pending, answer()]), status: "running" as const }],
    };
    const settled = reduceSession(view, {
      sessionId: "s",
      runId: "run",
      seq: 1,
      event: { type: "settled", status, endedAt: 2 },
    });
    expect(collectAnswerSources(settled.runs[0], "answer").map((entry) => entry.url)).toEqual([source().url]);
    expect(settled.runs[0].orderedBlocks[1]).toMatchObject({ status: "error", web: { status: "cancelled" } });
  },
);

test("SSR is closed and side-effect free, with answer actions ordered copy, fork, sources, time", () => {
  const readIcon = vi.fn(async () => png);
  const sources = collect([tool()]);
  const markup = renderToStaticMarkup(
    createElement(AnswerSources, { sources, sessionId: "s", runId: "r", readIcon, onLink: vi.fn() }),
  );
  expect(markup).toContain('aria-expanded="false"');
  expect(markup).not.toContain("answer-sources-popover");
  expect(markup).not.toContain("<img");
  expect(readIcon).not.toHaveBeenCalled();
  expect(
    renderToStaticMarkup(createElement(AnswerSources, { sources: [], runId: "r", onLink: vi.fn() })),
  ).toBe("");
  const renderRun = (current: RunView) =>
    renderToStaticMarkup(
      createElement(RunGroup, {
        run: current,
        sessionId: "s",
        onLink: vi.fn(),
        onCopy: vi.fn(),
        onFork: vi.fn(),
        expanded: false,
        onToggle: vi.fn(),
        blocks: {},
        onBlockToggle: vi.fn(),
      }),
    );
  const view = run([tool(), answer()]);
  const runMarkup = renderRun(view);
  const actions = runMarkup.slice(runMarkup.indexOf('class="message-actions assistant-message-actions"'));
  const order = ['aria-label="复制"', 'aria-label="分叉"', "answer-sources-trigger", "message-time"].map(
    (marker) => actions.indexOf(marker),
  );
  expect(order.every((index) => index >= 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));
  expect(renderRun(run([answer()]))).not.toContain("answer-sources-trigger");
  expect(renderRun({ ...view, status: "running" })).not.toContain("answer-sources-trigger");
  expect(renderRun(run([tool(), answer(), tool("later")]))).not.toContain("answer-sources-trigger");
});

test("source trigger uses the action row gap and preserves bounded popover and narrow viewport styling", () => {
  const css = readFileSync(new URL("../src/components/answer-sources.css", import.meta.url), "utf8");
  const sharedCss = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  expect(css).toContain(".answer-sources-popover {");
  expect(css).toContain("--radix-popover-content-available-width");
  expect(css).toContain("--radix-popover-content-available-height");
  expect(css).toContain("max-height: min(");
  expect(css).toContain("overscroll-behavior: contain");
  expect(css).toContain("overflow: auto");
  expect(css).toContain(".answer-source-link:focus-visible");
  const declarations = (selector: string) =>
    [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].trim() === selector)
      .map((match) => match[2])
      .join("\n");
  const trigger = declarations(".message-action.answer-sources-trigger");
  expect(trigger).not.toMatch(/margin(?:-[\w-]+)?\s*:/);
  expect(sharedCss).toMatch(/\.message-actions\s*\{[^}]*gap:\s*4px/);
  expect(trigger).toMatch(/flex-shrink:\s*1/);
  expect(trigger).toMatch(/min-width:\s*0/);
  expect(declarations(".answer-sources-icons")).toMatch(/overflow:\s*hidden/);
  expect(declarations(".answer-sources-icons")).toMatch(/min-width:\s*0/);
  expect(declarations(".answer-sources-trigger > span:last-child")).toMatch(/flex-shrink:\s*0/);
});

describe("safe source icon loading", () => {
  test.each([
    undefined,
    "",
    "https://example.com/icon.png",
    "file:///private/icon",
    "data:image/svg+xml,<svg/>",
    "data:text/html;base64,aGVsbG8=",
    "data:image/png;base64,aGVsbG8=",
    `${png}${"A".repeat(answerSourceLimits.iconData)}`,
  ])("rejects non-raster or unbounded data %#", (value) => {
    expect(safeSourceIconData(value)).toBeUndefined();
  });
  test("accepts a bounded PNG and shares the loader only for the same reader", () => {
    expect(safeSourceIconData(png)).toBe(png);
    const read = vi.fn(async () => png);
    expect(answerSourceIconLoader(read)).toBe(answerSourceIconLoader(read));
    expect(answerSourceIconLoader(vi.fn(async () => png))).not.toBe(answerSourceIconLoader(read));
  });
  test("coalesces calls, uses source URLs, and isolates session, run and enriched icon metadata", async () => {
    const read = vi.fn(async () => png);
    const load = createAnswerSourceIconLoader(read);
    const page = iconSource();
    const [one, two] = await Promise.all([load("s", "r", page), load("s", "r", { ...page })]);
    expect(one).toBe(png);
    expect(two).toBe(png);
    await load("s", "r", page);
    expect(read).toHaveBeenCalledExactlyOnceWith("s", "r", page.url);
    await load("other-session", "r", page);
    await load("s", "other-run", page);
    await load("s", "r", { ...page, siteIcon: "https://example.com/changed.png" });
    expect(read).toHaveBeenCalledTimes(4);
  });
  test("caches failures without rethrowing and skips absent/unsafe icon metadata", async () => {
    const read = vi.fn(async () => {
      throw new Error("Unavailable");
    });
    const load = createAnswerSourceIconLoader(read);
    expect(await load("s", "r", iconSource())).toBeUndefined();
    expect(await load("s", "r", iconSource())).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
    for (const siteIcon of [undefined, "file:///private", "javascript:evil()"])
      expect(await load("s", "r", { ...iconSource(), siteIcon })).toBeUndefined();
    expect(await load("", "r", iconSource())).toBeUndefined();
    expect(await load("s", "r", { ...iconSource(), url: "javascript:evil()" })).toBeUndefined();
    expect(read).toHaveBeenCalledOnce();
  });
  test("a temporary icon failure expires so an unchanged source can recover", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1000);
    try {
      const read = vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(png);
      const load = createAnswerSourceIconLoader(read);
      expect(await load("s", "r", iconSource())).toBeUndefined();
      expect(await load("s", "r", iconSource())).toBeUndefined();
      expect(read).toHaveBeenCalledOnce();
      now.mockReturnValue(1000 + answerSourceLimits.iconFailureTtl);
      expect(await load("s", "r", iconSource())).toBe(png);
      expect(read).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });
  test("limits concurrency and pending work, then evicts old cached data", async () => {
    let active = 0;
    let peak = 0;
    const read = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
      return png;
    });
    const load = createAnswerSourceIconLoader(read);
    const results = await Promise.all(
      Array.from({ length: answerSourceLimits.iconCache + 1 }, (_, index) =>
        load("s", "r", iconSource(index)),
      ),
    );
    expect(peak).toBe(answerSourceLimits.iconConcurrency);
    expect(read).toHaveBeenCalledTimes(answerSourceLimits.iconCache);
    expect(results.at(-1)).toBeUndefined();
    await load("s", "r", iconSource(answerSourceLimits.iconCache));
    await load("s", "r", iconSource(0));
    expect(read).toHaveBeenCalledTimes(answerSourceLimits.iconCache + 2);
  });
});
