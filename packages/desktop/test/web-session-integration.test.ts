import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import type { JsonObject } from "zpi-ai";
import { chunk } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import type { SubagentConfig } from "../src/shared/subagents.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (s: string) => Buffer.from(s),
  decryptString: (b: Buffer) => b.toString(),
};
const sse = (delta: unknown, reason = "stop") =>
  new Response(
    `data: ${JSON.stringify(chunk(delta))}\n\ndata: ${JSON.stringify(chunk({}, reason))}\n\ndata: [DONE]\n\n`,
    { headers: { "content-type": "text/event-stream" } },
  );
const call = (name: string, args: unknown) =>
  sse(
    {
      tool_calls: [
        {
          index: 0,
          id: `call-${name}`,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    "tool_calls",
  );
const toolNames = (body: JsonObject) =>
  ((body.tools ?? []) as unknown as { function: { name: string } }[]).map((t) => t.function.name);
const messages = (body: JsonObject) => body.messages as unknown as { role: string; content: string }[];
const source = {
  title: "Example",
  url: "https://example.com/article",
  snippet: "Short excerpt",
  summary: "Summary",
  content: "",
  site_name: "Example",
  site_icon: "https://example.com/icon.png",
  date: null,
  rerank_score: 2,
  authority: 3,
};
async function fixture(
  handler: (body: JsonObject, index: number) => Response = () => sse({ content: "ok" }),
) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-web-session-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const requests: JsonObject[] = [];
  const webRequests: { url: string; body: unknown; authorization: string | null }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const body = (await request.json()) as JsonObject;
    if (request.url.startsWith("https://api.deepseek.com/v1/tools/")) {
      webRequests.push({ url: request.url, body, authorization: request.headers.get("authorization") });
      return Response.json(
        request.url.endsWith("search")
          ? { results: [source] }
          : { title: "Example", content: "# Article\n\nFetched content." },
      );
    }
    if (!request.url.startsWith("https://chat.example/v1/")) throw new Error("Unexpected test destination");
    if (
      messages(body).some(
        (row) => typeof row.content === "string" && row.content.startsWith("ZPI_SESSION_TITLE:"),
      )
    )
      return sse({ content: '{"session_title":"Test"}' });
    return handler(body, requests.push(body) - 1);
  };
  const settings = new SettingsStore(dir, codec);
  settings.saveProvider({
    id: "chat",
    name: "Other chat provider",
    baseUrl: "https://chat.example/v1",
    apiKey: "fake-chat-key",
    models: [{ id: "model", reasoning: false }],
  });
  settings.rememberSelection({ provider: "chat", modelId: "model", reasoning: "none" });
  const home = join(dir, "home");
  const workspace = join(dir, "workspace");
  const open = async () => {
    const host = new SessionHost(dir, settings, home, workspace, transport);
    cleanup.push(() => host.close());
    await host.init();
    return host;
  };
  const host = await open();
  const session = host.createSession(null);
  return { dir, settings, host, session, requests, webRequests, open };
}
async function run(host: SessionHost, id: string, text = "Find information") {
  await host.startRun({ sessionId: id, text });
  await host.activeRuns.get(id)?.done;
}

test("one capability drives catalog, preview, live tools and first-send frozen inheritance", async () => {
  const f = await fixture();
  expect(f.host.listTools().map((t) => t.name)).not.toContain("web_search");
  expect((await f.host.previewPrompt()).prompt).not.toContain("web_search");
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  expect(f.host.listTools().map((t) => t.name)).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  expect((await f.host.previewPrompt()).prompt).toContain("web_search");
  await run(f.host, f.session.id);
  expect(toolNames(f.requests.at(-1) ?? {})).toEqual(expect.arrayContaining(["web_search", "web_fetch"]));
  f.settings.setCapabilityEnabled("webSearch", false);
  await run(f.host, f.session.id, "Keep old tools");
  expect(toolNames(f.requests.at(-1) ?? {})).toContain("web_search");
  const side = await f.host.createSideChat(f.session.id);
  await run(f.host, side.id, "Side chat inherits");
  expect(toolNames(f.requests.at(-1) ?? {})).toContain("web_search");
  const next = f.host.createSession(null);
  await run(f.host, next.id, "New chat has no web tools");
  expect(toolNames(f.requests.at(-1) ?? {})).not.toContain("web_search");
  await f.host.close();
  const restored = await f.open();
  await run(restored, f.session.id, "Restored frozen tools");
  expect(toolNames(f.requests.at(-1) ?? {})).toContain("web_search");
});

test("legacy frozen sessions missing webSearch remain off and invalid values block execution", async () => {
  const f = await fixture();
  await run(f.host, f.session.id);
  await f.host.close();
  const task = f.settings.state.getTask(f.session.id);
  if (!task) throw new Error("Missing task fixture");
  const configuration = { ...(task.frozenConfiguration as Record<string, unknown>) };
  delete configuration.webSearch;
  f.settings.state.upsertTask({ ...task, frozenConfiguration: configuration });
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  const restored = await f.open();
  await run(restored, f.session.id);
  expect(toolNames(f.requests.at(-1) ?? {})).not.toContain("web_search");
  await restored.close();
  f.settings.state.upsertTask({
    ...f.settings.state.getTask(f.session.id),
    ...task,
    frozenConfiguration: { ...configuration, webSearch: "true" },
  });
  const invalid = await f.open();
  await expect(run(invalid, f.session.id)).rejects.toThrow("Invalid web search capability");
});

test("other chat providers use independent DeepSeek web credentials, stream details and restore results", async () => {
  const f = await fixture((body) => {
    const results = messages(body).filter((row) => row.role === "tool");
    if (!results.length) return call("web_search", { query: "Example", count: 1, need_content: false });
    if (results.length === 1) return call("web_fetch", { url: source.url });
    return sse({ content: "Answer with source" });
  });
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-only-key", enabled: true });
  const events: unknown[] = [];
  f.host.subscribe((event) => events.push(event.event));
  await run(f.host, f.session.id);
  expect(f.webRequests).toEqual([
    expect.objectContaining({
      url: "https://api.deepseek.com/v1/tools/search",
      authorization: "Bearer fake-web-only-key",
    }),
    expect.objectContaining({
      url: "https://api.deepseek.com/v1/tools/fetch",
      authorization: "Bearer fake-web-only-key",
    }),
  ]);
  expect(f.webRequests[0].body).not.toHaveProperty("ori_question");
  expect(f.webRequests[0].body).not.toHaveProperty("localization");
  const view = f.host.getSessionSnapshot(f.session.id).view;
  const runId = view.runs[0].runId;
  expect(f.host.recordedWebSourceIcon(f.session.id, runId, source.url)).toBe(source.site_icon);
  expect(f.host.recordedWebSourceIcon(f.session.id, runId, "https://other.example/article")).toBeUndefined();
  expect(f.host.recordedWebSourceIcon(f.session.id, runId, "http://127.0.0.1/")).toBeUndefined();
  expect(() => f.host.recordedWebSourceIcon(f.session.id, "unrecorded-run", source.url)).toThrow();
  const emptySession = f.host.createSession(null);
  expect(() => f.host.recordedWebSourceIcon(emptySession.id, runId, source.url)).toThrow();
  expect(view.runs[0].orderedBlocks).toContainEqual(
    expect.objectContaining({
      name: "web_search",
      web: expect.objectContaining({
        status: "success",
        results: [expect.objectContaining({ title: "Example" })],
      }),
    }),
  );
  expect(events).toContainEqual(
    expect.objectContaining({ type: "tool_update", web: expect.objectContaining({ status: "pending" }) }),
  );
  expect(JSON.stringify(f.requests)).not.toContain("fake-web-only-key");
  expect(JSON.stringify(view)).not.toContain("fake-web-only-key");
  expect(await readFile(f.host.sessionPath(f.session.id), "utf8")).not.toContain("fake-web-only-key");
  await f.host.close();
  const restored = await f.open();
  expect(restored.recordedWebSourceIcon(f.session.id, runId, source.url)).toBe(source.site_icon);
  const side = await restored.createSideChat(f.session.id);
  expect(() => restored.recordedWebSourceIcon(side.id, runId, source.url)).toThrow();
  expect(restored.getSessionSnapshot(f.session.id).view.runs[0].orderedBlocks).toContainEqual(
    expect.objectContaining({
      name: "web_fetch",
      web: expect.objectContaining({
        status: "success",
        content: expect.stringContaining("Fetched content"),
      }),
    }),
  );
});

test.each([
  { tools: ["*"], disallowedTools: ["web_fetch"], expected: ["web_search"] },
  { tools: ["web_fetch"], expected: ["web_fetch"] },
  { tools: ["read"], expected: [] },
])("subagents inherit web capability and honor explicit tool profiles: %j", async (profile) => {
  const childRequests: JsonObject[] = [];
  const f = await fixture((body) => {
    if (!toolNames(body).includes("Agent")) {
      childRequests.push(body);
      return sse({ content: "Child done" });
    }
    if (!messages(body).some((row) => row.role === "tool"))
      return call("Agent", {
        subagent_type: "web-researcher",
        description: "Research",
        prompt: "Inspect web tools",
      });
    return sse({ content: "Parent done" });
  });
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  f.host.saveSubagent({
    scope: "user",
    sessionId: null,
    config: {
      name: "web-researcher",
      description: "Research the web",
      systemPrompt: "Research as requested.",
      color: "blue",
      injectAgentsMd: false,
      tools: profile.tools,
      disallowedTools: profile.disallowedTools,
    } satisfies SubagentConfig,
  });
  await run(f.host, f.session.id);
  expect(childRequests).toHaveLength(1);
  expect(toolNames(childRequests[0]).filter((name) => name.startsWith("web_"))).toEqual(profile.expected);
});

test("new sessions freeze availability only after provider and global switches are enabled", async () => {
  const f = await fixture();
  expect(f.settings.get().capabilities.webSearch).toBe(false);
  expect(f.settings.get().webSearch.enabled).toBe(false);
  await run(f.host, f.session.id, "Freeze before setup");
  expect(toolNames(f.requests.at(-1) ?? {})).not.toContain("web_search");
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key" });
  expect(f.host.listTools().map((tool) => tool.name)).not.toContain("web_search");
  expect((await f.host.previewPrompt()).prompt).not.toContain("web_search");
  f.settings.saveWebSearch({ provider: "deepseek", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  expect(f.host.listTools().map((tool) => tool.name)).toContain("web_search");
  expect((await f.host.previewPrompt()).prompt).toContain("web_search");
  await run(f.host, f.session.id, "Old session stays restricted");
  expect(toolNames(f.requests.at(-1) ?? {})).not.toContain("web_search");
  const side = await f.host.createSideChat(f.session.id);
  await run(f.host, side.id, "Side inherits frozen false");
  expect(toolNames(f.requests.at(-1) ?? {})).not.toContain("web_search");
  const fresh = f.host.createSession(null);
  await run(f.host, fresh.id, "Ready at first send");
  expect(toolNames(f.requests.at(-1) ?? {})).toContain("web_search");
  f.settings.setCapabilityEnabled("webSearch", false);
  expect(f.host.listTools().map((tool) => tool.name)).not.toContain("web_search");
  expect((await f.host.previewPrompt()).prompt).not.toContain("web_search");
  f.settings.setCapabilityEnabled("webSearch", true);
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "" });
  expect(f.host.listTools().map((tool) => tool.name)).not.toContain("web_search");
  expect((await f.host.previewPrompt()).prompt).not.toContain("web_search");
});

test("frozen web tools enforce provider and key changes before each request, and may recover", async () => {
  let issueTool = false;
  const f = await fixture(() => {
    if (issueTool) {
      issueTool = false;
      return call("web_search", { query: "Example" });
    }
    return sse({ content: "Answer" });
  });
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  await run(f.host, f.session.id, "Freeze ready");
  for (const change of [{ enabled: false }, { enabled: true, apiKey: "fake-web-key" }, { apiKey: "" }]) {
    f.settings.saveWebSearch({ provider: "deepseek", ...change });
    const before = f.webRequests.length;
    issueTool = true;
    await run(f.host, f.session.id, "Use frozen tools");
    expect(toolNames(f.requests.at(-1) ?? {})).toContain("web_search");
    const allowed = change.enabled === true;
    expect(f.webRequests).toHaveLength(before + Number(allowed));
    const current = f.host.getSessionSnapshot(f.session.id).view.runs.at(-1);
    const web = current?.orderedBlocks.find((block) => block.type === "tool" && block.name === "web_search");
    expect(web).toMatchObject({ status: allowed ? "completed" : "error" });
    if (!allowed) expect(web).toMatchObject({ web: { status: "error" } });
  }
});

test("recorded icon authorization uses the source run even outside the restored history page", async () => {
  let issueTool = true;
  const f = await fixture(() => {
    if (issueTool) {
      issueTool = false;
      return call("web_search", { query: "Example" });
    }
    return sse({ content: "Answer" });
  });
  f.settings.saveWebSearch({ provider: "deepseek", apiKey: "fake-web-key", enabled: true });
  f.settings.setCapabilityEnabled("webSearch", true);
  await run(f.host, f.session.id);
  const originalRun = f.host.getSessionSnapshot(f.session.id).view.runs[0].runId;
  for (let index = 0; index < 11; index++) await run(f.host, f.session.id, `Follow-up ${index}`);
  const lastRun = f.host.getSessionSnapshot(f.session.id).view.runs.at(-1)?.runId;
  if (!lastRun) throw new Error("Missing last run");
  expect(f.host.recordedWebSourceIcon(f.session.id, lastRun, source.url)).toBeUndefined();
  await f.host.close();
  const restored = await f.open();
  expect(restored.getSessionSnapshot(f.session.id).view.runs.some((run) => run.runId === originalRun)).toBe(
    false,
  );
  expect(restored.recordedWebSourceIcon(f.session.id, originalRun, source.url)).toBe(source.site_icon);
});
