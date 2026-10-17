import type { TObject } from "typebox";
import { Value } from "typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentToolResult, AgentToolUpdateCallback } from "zpi-agent";
import type { ExtensionToolContext } from "zpi-coding-agent";
import type { WebToolDetails } from "zpi-ui";
import type { WebSearchResult } from "../src/main/web-client.ts";

let WebTools: typeof import("../src/main/web-tools.ts").WebTools;
let publicWebUrl: typeof import("../src/main/web-client.ts").publicWebUrl;
let WEB_RESPONSE_BYTES: number;
let WEB_DEADLINE_MS: number;
let WEB_TEXT_LIMIT: number;
let transport: ReturnType<typeof vi.fn<typeof fetch>>;
const key = "sk-mock-secret-never-send";

const source = (overrides: Partial<WebSearchResult> = {}): WebSearchResult => ({
  title: "A source title",
  url: "https://example.com/article",
  snippet: "A short snippet",
  summary: "A more complete summary",
  content: "# Page content\n\nUseful source text.",
  site_name: "Example",
  site_icon: "https://example.com/favicon.ico",
  date: "2026-06-01T00:00:00+00:00",
  rerank_score: 2.4,
  authority: 3,
  ...overrides,
});
const json = (value: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(value), { status, headers });
const web = (result: AgentToolResult) => (result.details as unknown as { web: WebToolDetails }).web;
const text = (result: AgentToolResult) =>
  result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
const tools = (getApiKey = () => key) => new WebTools({ getApiKey, requestFetch: transport });
function execute(
  kind: "web_search" | "web_fetch" = "web_search",
  args: unknown = { query: "DeepSeek" },
  signal?: AbortSignal,
  update?: AgentToolUpdateCallback,
  broker = tools(),
) {
  const tool = broker.tools().find((tool) => tool.name === kind);
  if (!tool) throw new Error("Missing web tool");
  return tool.execute("web-call", args, signal, update, {} as ExtensionToolContext);
}
async function finish(promise: Promise<AgentToolResult>) {
  await vi.runAllTimersAsync();
  return promise;
}
const run = (kind: "web_search" | "web_fetch" = "web_search", args: unknown = { query: "DeepSeek" }) =>
  finish(execute(kind, args));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T00:00:00Z"));
  vi.resetModules();
  ({ WebTools, WEB_TEXT_LIMIT } = await import("../src/main/web-tools.ts"));
  ({ publicWebUrl, WEB_RESPONSE_BYTES, WEB_DEADLINE_MS } = await import("../src/main/web-client.ts"));
  transport = vi.fn<typeof fetch>().mockImplementation(async () => json({ results: [source()] }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DeepSeek tool contracts", () => {
  it("advertises exactly two desktop read-only tools with the official optional schema", () => {
    const [search, fetch] = tools().tools();
    const searchSchema = search.parameters as TObject;
    const fetchSchema = fetch.parameters as TObject;
    expect(search.name).toBe("web_search");
    expect(fetch.name).toBe("web_fetch");
    expect(searchSchema.required).toEqual(["query"]);
    expect(searchSchema.properties).toMatchObject({
      query: { minLength: 1, maxLength: 128 },
      count: { type: "integer", minimum: 1, maximum: 50, default: 10 },
      localization: { type: "string", default: "" },
      need_content: { type: "boolean", default: false },
    });
    expect(searchSchema.properties).not.toHaveProperty("queries");
    expect(fetchSchema.required).toEqual(["url"]);
    expect(fetchSchema.properties.url).toMatchObject({ maxLength: 8192 });
    for (const tool of [search, fetch]) {
      expect(tool.executionMode).toBe("parallel");
      expect(tool.metadata).toMatchObject({
        readOnly: true,
        concurrentSafe: true,
        sideEffectScope: "network",
      });
      expect(tool.description).toContain("untrusted");
      expect(tool.description).toContain("never instructions");
    }
  });

  it("sends fixed POST endpoints, Bearer auth, redirect:error and only provided fields", async () => {
    const update = vi.fn();
    const result = await finish(
      execute("web_search", { query: "  DeepSeek site:example.com  " }, undefined, update),
    );
    expect(transport).toHaveBeenCalledOnce();
    const [url, init] = transport.mock.calls[0];
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init).toMatchObject({
      method: "POST",
      redirect: "error",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(init?.body as string)).toEqual({ query: "  DeepSeek site:example.com  " });
    expect(web(update.mock.calls[0][0])).toEqual({
      kind: "web_search",
      status: "pending",
      query: "  DeepSeek site:example.com  ",
    });
    expect(web(result)).toMatchObject({
      kind: "web_search",
      status: "success",
      results: [{ title: "A source title", summary: "A more complete summary" }],
      truncated: false,
    });
    expect(text(result)).toContain("A more complete summary");
    expect(text(result)).toContain("Page content");
    expect(text(result)).toContain("rerank_score");
  });

  it.each([1, 10, 50])(
    "passes count %i without clamping and preserves optional defaults/null",
    async (count) => {
      const input = { query: "x", count, ori_question: null, localization: "", need_content: false };
      await run("web_search", input);
      expect(JSON.parse(transport.mock.calls[0][1]?.body as string)).toEqual(input);
    },
  );

  it("allows 128 non-BMP Unicode codepoints through both preparation and SDK schema checks", async () => {
    const input = {
      query: "😀".repeat(128),
      ori_question: "😀".repeat(128),
      localization: "1.2.3.4",
      need_content: true,
    };
    const tool = tools().tools()[0];
    expect(tool.prepareArguments?.(input)).toEqual(input);
    expect(Value.Check(tool.parameters, input)).toBe(true);
    expect(web(await run("web_search", input)).status).toBe("success");
  });

  it("allows whitespace in ori_question, unlike a whitespace-only query", async () => {
    expect(web(await run("web_search", { query: "valid", ori_question: " " })).status).toBe("success");
  });

  it.each([
    {},
    { queries: ["x"] },
    { query: null },
    { query: 123 },
    { query: "" },
    { query: " \t\n" },
    { query: "x".repeat(129) },
    { query: "😀".repeat(129) },
    { query: "e\u0301".repeat(65) },
    { query: "x", count: 0 },
    { query: "x", count: 51 },
    { query: "x", count: 1.5 },
    { query: "x", count: "10" },
    { query: "x", count: null },
    { query: "x", count: NaN },
    { query: "x", ori_question: "" },
    { query: "x", ori_question: "😀".repeat(129) },
    { query: "x", ori_question: 1 },
    { query: "x", localization: null },
    { query: "x", need_content: "true" },
    { query: "x", need_content: null },
    { query: "x", unknown: true },
  ])("rejects invalid search input before the network: %j", async (input) => {
    expect(() => tools().tools()[0].prepareArguments?.(input)).toThrow("Invalid web_search");
    const result = await run("web_search", input);
    expect(result.isError).toBe(true);
    expect(web(result).status).toBe("error");
    expect(transport).not.toHaveBeenCalled();
  });

  it("reads an empty title and Markdown content from the fetch endpoint", async () => {
    transport.mockResolvedValue(json({ title: "", content: "# Markdown\n\nHello, world." }));
    const result = await run("web_fetch", { url: "https://example.com/article" });
    expect(transport.mock.calls[0][0]).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(JSON.parse(transport.mock.calls[0][1]?.body as string)).toEqual({
      url: "https://example.com/article",
    });
    expect(web(result)).toMatchObject({
      kind: "web_fetch",
      status: "success",
      title: "",
      content: "# Markdown\n\nHello, world.",
      truncated: false,
    });
    expect(text(result)).toContain("untrusted source data");
  });
});

describe("public URL screening", () => {
  it.each([
    "file:///etc/passwd",
    "data:text/plain,hello",
    "javascript:alert(1)",
    "ftp://example.com/a",
    "http:example.com",
    "https:///example.com",
    "https://user:pass@example.com/a",
    "https://@example.com/a",
    "https://example.com@127.0.0.1/",
    "http://localhost/",
    "http://sub.localhost./",
    "http://printer/",
    "http://service.local/",
    "http://service.internal/",
    "http://router.home.arpa/",
    "http://site.invalid/",
    "http://127.0.0.1/",
    "http://127.1/",
    "http://2130706433/",
    "http://0x7f000001/",
    "http://0177.0.0.1/",
    "http://0.0.0.0/",
    "http://10.1.2.3/",
    "http://172.16.1.1/",
    "http://172.31.255.255/",
    "http://192.168.1.1/",
    "http://169.254.169.254/",
    "http://100.64.0.1/",
    "http://224.0.0.1/",
    "http://198.18.0.1/",
    "http://192.0.2.1/",
    "http://[::1]/",
    "http://[::]/",
    "http://[fc00::1]/",
    "http://[fe80::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[2002:7f00:1::]/",
    "http://[2001:db8::1]/",
    "http://[2001::1]/",
    "http://[3fff::1]/",
    "https://example.com/a\nb",
    "https://example.com\\@127.0.0.1",
    "https://example.com/\u0000",
    "https://example.com/\u007f",
    `https://example.com/${"x".repeat(8192)}`,
  ])("rejects nonpublic, malformed or credential-bearing URL %s", async (url) => {
    expect(publicWebUrl(url)).toBeNull();
    const result = await run("web_fetch", { url });
    expect(result.isError).toBe(true);
    expect(web(result)).not.toHaveProperty("url");
    expect(transport).not.toHaveBeenCalled();
  });

  it.each([
    "https://example.com/hello?x=1#part",
    "http://example.com:8080/path",
    "https://例子.中国/a",
    "https://8.8.8.8/",
    "https://[2001:4860:4860::8888]/",
    "https://example.com./",
  ])("allows ordinary public URLs %s", (url) => {
    expect(publicWebUrl(url)).toBe(url);
  });

  it("preserves a valid Unicode URL instead of percent-encoding past the schema length", async () => {
    const url = `https://example.com/${"汉".repeat(1000)}`;
    expect(new URL(url).href.length).toBeGreaterThan(8192);
    const tool = tools().tools()[1];
    const prepared = tool.prepareArguments?.({ url });
    expect(Value.Check(tool.parameters, prepared)).toBe(true);
    transport.mockResolvedValue(json({ title: "Page", content: "Text" }));
    const result = await run("web_fetch", { url });
    expect(result.isError).toBe(false);
    expect(JSON.parse(transport.mock.calls[0][1]?.body as string)).toEqual({ url });
    expect(web(result).url).toBe(url);
  });

  it("accepts the exact 8192-character URL boundary", () => {
    const base = "https://example.com/";
    const url = base + "x".repeat(8192 - base.length);
    expect(publicWebUrl(url)).toBe(url);
  });

  it.each([{}, { url: 1 }, { url: null }, { url: "https://example.com", content: "x" }])(
    "rejects malformed fetch arguments %j",
    async (input) => {
      expect(() => tools().tools()[1].prepareArguments?.(input)).toThrow("Invalid web_fetch");
      expect((await run("web_fetch", input)).isError).toBe(true);
      expect(transport).not.toHaveBeenCalled();
    },
  );
});

describe("runtime response validation and budgets", () => {
  it("treats a successful empty search as no results", async () => {
    transport.mockResolvedValue(json({ results: [] }));
    const result = await run();
    expect(result.isError).toBe(false);
    expect(web(result)).toMatchObject({ status: "success", results: [], message: "No matching results." });
  });

  it("preserves nullable source metadata and removes unsafe icons without loading them", async () => {
    transport.mockResolvedValue(
      json({ results: [source({ site_name: null, site_icon: "http://127.0.0.1/icon", date: null })] }),
    );
    const result = await run();
    expect(web(result).results?.[0]).toMatchObject({ site_name: null, site_icon: null, date: null });
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(Object.keys(source()))("rejects a search result missing required field %s", async (field) => {
    const item = { ...source() } as Record<string, unknown>;
    delete item[field];
    transport.mockResolvedValue(json({ results: [item] }));
    expect((await run()).isError).toBe(true);
  });

  it.each([
    null,
    [],
    {},
    { results: null },
    { results: [null] },
    { results: ["wrong"] },
    { results: Array.from({ length: 51 }, () => source()) },
    { results: [source({ title: null as unknown as string })] },
    { results: [source({ date: "yesterday" })] },
    { results: [source({ date: "2026-99-99T00:00:00Z" })] },
    { results: [source({ rerank_score: -1 })] },
    { results: [source({ rerank_score: 3.1 })] },
    { results: [source({ authority: 4.1 })] },
    { results: [source({ authority: -2 })] },
    { results: [source({ url: "file:///private" })] },
    { results: [source({ site_name: false as unknown as string })] },
  ])("rejects invalid search responses %j", async (value) => {
    transport.mockResolvedValue(json(value));
    const result = await run();
    expect(result.isError).toBe(true);
    expect(web(result).status).toBe("error");
    expect(text(result)).toContain("invalid web response");
  });

  it.each([
    null,
    {},
    { title: "page" },
    { content: "body" },
    { title: null, content: "body" },
    { title: "", content: "" },
    { title: "", content: " \n" },
  ])("rejects missing or empty fetch content %j", async (value) => {
    transport.mockResolvedValue(json(value));
    expect((await run("web_fetch", { url: "https://example.com" })).isError).toBe(true);
  });

  it.each(["", "not JSON", '{"results":'])(
    "rejects empty or malformed JSON without exposing it: %s",
    async (body) => {
      transport.mockResolvedValue(new Response(body));
      const result = await run();
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("invalid web response");
    },
  );

  it("rejects a missing body", async () => {
    transport.mockResolvedValue(new Response(null));
    expect((await run()).isError).toBe(true);
  });

  it("keeps 50 compact sources", async () => {
    transport.mockResolvedValue(
      json({
        results: Array.from({ length: 50 }, (_, index) => source({ title: `Source ${index}`, content: "" })),
      }),
    );
    const result = await run("web_search", { query: "all", count: 50 });
    expect(web(result).results).toHaveLength(50);
    expect(web(result).truncated).toBe(false);
    expect(text(result).length).toBeLessThanOrEqual(WEB_TEXT_LIMIT);
  });

  it("bounds model search text including JSON escaping and marks truncation", async () => {
    transport.mockResolvedValue(
      json({
        results: Array.from({ length: 50 }, () =>
          source({ content: "\u0000\n😀".repeat(1000), summary: "long summary ".repeat(1000) }),
        ),
      }),
    );
    const result = await run("web_search", { query: "all", count: 50, need_content: true });
    expect(result.isError).toBe(false);
    expect(text(result).length).toBeLessThanOrEqual(WEB_TEXT_LIMIT);
    expect(web(result).truncated).toBe(true);
    expect(text(result)).toContain("truncated");
    expect(JSON.stringify(result.details).length).toBeLessThanOrEqual(WEB_TEXT_LIMIT + 1000);
  });

  it("bounds fetched Markdown and title without splitting surrogate pairs", async () => {
    transport.mockResolvedValue(json({ title: "😀".repeat(1000), content: "😀".repeat(100_000) }));
    const result = await run("web_fetch", { url: "https://example.com/article" });
    expect(text(result).length).toBeLessThanOrEqual(WEB_TEXT_LIMIT);
    expect(web(result).truncated).toBe(true);
    expect(web(result).content?.isWellFormed()).toBe(true);
    expect(web(result).title?.isWellFormed()).toBe(true);
  });

  it("rejects an oversized content-length before reading", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({ cancel });
    transport.mockResolvedValue(
      new Response(body, { headers: { "content-length": String(WEB_RESPONSE_BYTES + 1) } }),
    );
    const result = await run();
    expect(result.isError).toBe(true);
    expect(web(result).truncated).toBe(true);
    expect(cancel).toHaveBeenCalled();
  });

  it("bounds streamed bytes even with no or incorrect content-length", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(WEB_RESPONSE_BYTES));
        controller.enqueue(new Uint8Array(1));
      },
      cancel,
    });
    transport.mockResolvedValue(new Response(body, { headers: { "content-length": "1" } }));
    const result = await run();
    expect(web(result)).toMatchObject({ status: "error", truncated: true });
    expect(cancel).toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("decodes split multibyte UTF-8 chunks correctly", async () => {
    const bytes = new TextEncoder().encode(JSON.stringify({ title: "你好😀", content: "正文😀" }));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const byte of bytes) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    });
    transport.mockResolvedValue(new Response(body));
    const result = await run("web_fetch", { url: "https://example.com" });
    expect(web(result).content).toBe("正文😀");
  });
});

describe("failure handling, retries, and redaction", () => {
  it.each([400, 401, 402, 403, 404, 405, 413, 422])(
    "does not retry HTTP %i or echo its body",
    async (status) => {
      transport.mockImplementation(async () =>
        json({ error: { message: `private server error ${key}` } }, status),
      );
      const update = vi.fn();
      const result = await finish(execute("web_search", { query: "x" }, undefined, update));
      expect(transport).toHaveBeenCalledOnce();
      expect(result.isError).toBe(true);
      expect(web(result).status).toBe("error");
      expect(web(update.mock.calls.at(-1)?.[0])).toEqual(web(result));
      expect(JSON.stringify(result)).not.toContain(key);
      expect(JSON.stringify(result)).not.toContain("private server error");
    },
  );

  it.each([408, 429, 500, 502, 503, 504])(
    "limits retries for HTTP %i to three total attempts",
    async (status) => {
      transport.mockImplementation(async () => json({ error: key }, status));
      const result = await run();
      expect(transport).toHaveBeenCalledTimes(3);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("after limited retries");
    },
  );

  it("recovers from a retryable response while preserving request fields", async () => {
    transport
      .mockResolvedValueOnce(json({ error: "limited" }, 429, { "retry-after": "1" }))
      .mockResolvedValueOnce(json({ results: [source()] }));
    const result = await run("web_search", { query: "x", count: 3 });
    expect(result.isError).toBe(false);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[0][1]?.body).toBe(transport.mock.calls[1][1]?.body);
  });

  it.each(["30", "999999", "9".repeat(400), "Sat, 17 Oct 2026 00:10:00 GMT"])(
    "does not retry early when Retry-After %s exceeds the deadline",
    async (header) => {
      const times: number[] = [];
      transport.mockImplementation(async () => {
        times.push(Date.now());
        return times.length === 1 ? json({}, 429, { "retry-after": header }) : json({ results: [] });
      });
      const result = await run();
      expect(times).toHaveLength(1);
      expect(result.isError).toBe(true);
      expect(text(result)).toContain("retry wait");
    },
  );

  it("honors a ten-second Retry-After without retrying at the fallback cap", async () => {
    const times: number[] = [];
    transport.mockImplementation(async () => {
      times.push(Date.now());
      return times.length === 1 ? json({}, 429, { "retry-after": "10" }) : json({ results: [] });
    });
    const pending = execute();
    await vi.advanceTimersByTimeAsync(9999);
    expect(times).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await pending).isError).toBe(false);
    expect(times[1] - times[0]).toBe(10_000);
  });

  it("uses Retry-After HTTP dates and defaults invalid values", async () => {
    const times: number[] = [];
    transport.mockImplementation(async () => {
      times.push(Date.now());
      if (times.length === 1) return json({}, 503, { "retry-after": "Sat, 17 Oct 2026 00:00:02 GMT" });
      if (times.length === 2) return json({}, 503, { "retry-after": "nonsense" });
      return json({ results: [] });
    });
    await run();
    expect(times[1] - times[0]).toBe(2000);
    expect(times[2] - times[1]).toBe(1000);
  });

  it.each([301, 302, 303, 307, 308])(
    "stops endpoint redirects (HTTP %i) without visiting Location",
    async (status) => {
      transport.mockResolvedValue(
        new Response(null, { status, headers: { Location: "https://evil.example/steal" } }),
      );
      const result = await run();
      expect(transport).toHaveBeenCalledOnce();
      expect(text(result)).toContain("unexpected redirect");
      expect(JSON.stringify(result)).not.toContain("evil.example");
    },
  );

  it("rejects an already redirected transport response", async () => {
    const response = json({ results: [] });
    Object.defineProperty(response, "redirected", { value: true });
    transport.mockResolvedValue(response);
    expect((await run()).isError).toBe(true);
  });

  it.each([new Error(`request failed: Bearer ${key}`), `raw ${key}`, { message: key }])(
    "sanitizes arbitrary network failures without retries",
    async (error) => {
      transport.mockRejectedValue(error);
      const result = await run();
      expect(transport).toHaveBeenCalledOnce();
      expect(text(result)).toBe(
        "Unable to reach DeepSeek's web service. Check your connection and try again.",
      );
      expect(JSON.stringify(result)).not.toContain(key);
    },
  );

  it("sanitizes stream read errors", async () => {
    transport.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error(key));
          },
        }),
      ),
    );
    const result = await run();
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it.each(["", " \t", "secret\ninjected"])("rejects missing or invalid configured keys %j", async (value) => {
    const result = await finish(
      execute(
        "web_search",
        { query: "x" },
        undefined,
        undefined,
        tools(() => value),
      ),
    );
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("API key in Settings");
    expect(transport).not.toHaveBeenCalled();
  });

  it("reports locked credentials as configuration failure without echoing their exception", async () => {
    const result = await finish(
      execute(
        "web_search",
        { query: "x" },
        undefined,
        undefined,
        tools(() => {
          throw new Error(`locked ${key}`);
        }),
      ),
    );
    expect(text(result)).toContain("credentials");
    expect(text(result)).not.toContain("connection");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(transport).not.toHaveBeenCalled();
  });

  it("redacts a key echoed in otherwise valid source content", async () => {
    transport.mockResolvedValue(
      json({ results: [source({ title: key, snippet: key, summary: key, content: key, site_name: key })] }),
    );
    const result = await run();
    expect(result.isError).toBe(false);
    expect(JSON.stringify(result)).not.toContain(key);
    expect(text(result)).toContain("[redacted]");
  });

  it("reads the key at execution time, never from tool arguments or response data", async () => {
    let current = "first-key";
    const broker = tools(() => current);
    const tool = broker.tools()[0];
    current = "second-key";
    await finish(tool.execute("call", { query: "x" }, undefined, undefined, {} as ExtensionToolContext));
    expect(transport.mock.calls[0][1]?.headers).toMatchObject({ Authorization: "Bearer second-key" });
  });
});

describe("cancellation, deadline and shared throttling", () => {
  it("returns visible cancellation without exposing abort reasons", async () => {
    const controller = new AbortController();
    const update = vi.fn();
    controller.abort(new Error(key));
    const result = await finish(execute("web_search", { query: "x" }, controller.signal, update));
    expect(result.isError).toBe(true);
    expect(web(result).status).toBe("cancelled");
    expect(web(update.mock.calls.at(-1)?.[0]).status).toBe("cancelled");
    expect(JSON.stringify(result)).not.toContain(key);
    expect(transport).not.toHaveBeenCalled();
  });

  it("aborts an in-flight request even if the injected fetch ignores its signal", async () => {
    transport.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const promise = execute("web_search", { query: "x" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    const signal = transport.mock.calls[0][1]?.signal;
    controller.abort();
    const result = await promise;
    expect(signal?.aborted).toBe(true);
    expect(web(result).status).toBe("cancelled");
    expect(transport).toHaveBeenCalledOnce();
  });

  it("cancels response streaming and does not report partial content as success", async () => {
    const cancel = vi.fn();
    transport.mockResolvedValue(
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"results":'));
          },
          cancel,
        }),
      ),
    );
    const controller = new AbortController();
    const promise = execute("web_search", { query: "x" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    const result = await promise;
    expect(web(result).status).toBe("cancelled");
    expect(cancel).toHaveBeenCalled();
    expect(transport).toHaveBeenCalledOnce();
  });

  it("cancels a queued limiter wait without starting that request or blocking later work", async () => {
    const first = execute();
    const controller = new AbortController();
    const second = execute("web_search", { query: "cancel me" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(web(await second).status).toBe("cancelled");
    const third = execute("web_search", { query: "third" });
    await finish(third);
    await first;
    expect(transport).toHaveBeenCalledTimes(2);
    expect(JSON.parse(transport.mock.calls[1][1]?.body as string).query).toBe("third");
  });

  it("cancels a retry wait without another HTTP request", async () => {
    transport.mockImplementation(async () => json({}, 429, { "retry-after": "20" }));
    const controller = new AbortController();
    const promise = execute("web_search", { query: "x" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(web(await promise).status).toBe("cancelled");
    await vi.runAllTimersAsync();
    expect(transport).toHaveBeenCalledOnce();
  });

  it.each(["request", "body"])("applies a single total deadline to a stalled %s", async (stage) => {
    if (stage === "request") transport.mockImplementation(() => new Promise(() => {}));
    else transport.mockResolvedValue(new Response(new ReadableStream()));
    const promise = execute();
    await vi.advanceTimersByTimeAsync(WEB_DEADLINE_MS - 1);
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const result = await promise;
    expect(web(result).status).toBe("error");
    expect(text(result)).toContain("30-second deadline");
    expect(transport.mock.calls[0][1]?.signal?.aborted).toBe(true);
  });

  it("discards a response that arrives after cancellation", async () => {
    let resolve!: (response: Response) => void;
    transport.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const controller = new AbortController();
    const promise = execute("web_search", { query: "x" }, controller.signal);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(web(await promise).status).toBe("cancelled");
    const cancel = vi.fn();
    resolve(new Response(new ReadableStream({ cancel })));
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalled();
  });

  it("shares a five-QPS operation limiter across instances and keys", async () => {
    const times: number[] = [];
    transport.mockImplementation(async () => {
      times.push(Date.now());
      return json({ results: [] });
    });
    const pending = Array.from({ length: 8 }, (_, index) =>
      execute(
        "web_search",
        { query: String(index) },
        undefined,
        undefined,
        tools(() => `key-${index}`),
      ),
    );
    await vi.runAllTimersAsync();
    await Promise.all(pending);
    expect(times).toHaveLength(8);
    for (let index = 1; index < times.length; index++)
      expect(times[index] - times[index - 1]).toBeGreaterThanOrEqual(200);
    expect(times[5] - times[0]).toBeGreaterThanOrEqual(1000);
  });

  it("uses independent search and fetch quotas", async () => {
    const times: number[] = [];
    transport.mockImplementation(async (url) => {
      times.push(Date.now());
      return String(url).endsWith("/fetch")
        ? json({ title: "Page", content: "Markdown" })
        : json({ results: [] });
    });
    const search = execute();
    const fetch = execute("web_fetch", { url: "https://example.com" });
    await vi.runAllTimersAsync();
    await Promise.all([search, fetch]);
    expect(times[0]).toBe(times[1]);
  });
});
