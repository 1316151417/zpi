import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import type { JsonObject } from "zpi-ai";
import { chunk } from "../../../tests/fake-server.ts";
import { QuickChatHost } from "../src/main/quick-chat-host.ts";
import { SettingsStore } from "../src/main/storage.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
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
const toolCall = (name: string, args: unknown) =>
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
const messages = (body: JsonObject) => body.messages as unknown as { role: string; content: string }[];
const toolNames = (body: JsonObject) =>
  (body.tools as unknown as { function: { name: string } }[]).map((tool) => tool.function.name);
async function fixture(
  handler: (body: JsonObject, index: number, signal: AbortSignal) => Response | Promise<Response> = () =>
    sse({ content: "quick answer" }),
) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "home", "Documents", "ZPI");
  await mkdir(join(cwd, ".zpi"), { recursive: true });
  await writeFile(join(cwd, "AGENTS.md"), "DO NOT LOAD PROJECT SENTINEL");
  await writeFile(join(cwd, ".zpi", "settings.json"), JSON.stringify({ defaultThinkingLevel: "NOT_VALID" }));
  await writeFile(join(cwd, "note.txt"), "read-only text");
  const settings = new SettingsStore(join(dir, "settings"), codec);
  cleanups.push(async () => settings.state.close());
  settings.saveProvider({
    id: "chat",
    name: "Fake chat",
    baseUrl: "https://chat.example/v1",
    apiKey: "fake-key",
    models: [
      { id: "one", reasoning: false },
      { id: "two", reasoning: false },
    ],
  });
  settings.rememberSelection({ provider: "chat", modelId: "one", reasoning: "none" });
  const requests: JsonObject[] = [];
  const web: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    if (request.url.startsWith("https://api.deepseek.com/v1/tools/")) {
      web.push(request.url);
      return Response.json(
        request.url.endsWith("search")
          ? {
              results: [
                {
                  title: "Example source",
                  url: "https://example.com/article",
                  snippet: "Excerpt",
                  summary: "Summary",
                  content: "",
                  site_name: "Example",
                  site_icon: "",
                  date: null,
                  rerank_score: 1,
                  authority: 1,
                },
              ],
            }
          : { title: "Example source", content: "Fetched public content" },
      );
    }
    if (!request.url.startsWith("https://chat.example/v1/")) throw new Error("Unexpected test endpoint");
    const body = (await request.json()) as JsonObject;
    return handler(body, requests.push(body) - 1, request.signal);
  };
  const host = new QuickChatHost(settings, cwd, transport);
  cleanups.push(() => host.close());
  return { dir, cwd, settings, host, requests, web };
}
async function run(host: QuickChatHost, text = "hello") {
  host.send(text);
  await host.waitForIdle();
}

test("temporary conversation reuses model configuration but never creates tasks, transcripts, or project resources", async () => {
  const f = await fixture();
  const before = await readdir(f.cwd, { recursive: true });
  const snapshots: unknown[] = [];
  f.host.subscribe((snapshot) => snapshots.push(snapshot));
  await run(f.host);
  await run(f.host, "follow up");
  expect(f.host.getSnapshot().session.runs).toHaveLength(2);
  expect(f.host.getSnapshot().session.runs[0].status).toBe("completed");
  expect(JSON.stringify(f.host.getSnapshot().session)).toContain("quick answer");
  expect(toolNames(f.requests[0])).toEqual(["read", "list", "search"]);
  expect(JSON.stringify(f.requests)).not.toContain("DO NOT LOAD PROJECT SENTINEL");
  expect(messages(f.requests[1]).filter((message) => message.role === "user")).toHaveLength(2);
  expect(f.settings.state.listTasks()).toEqual([]);
  expect(await readdir(f.cwd, { recursive: true })).toEqual(before);
  expect(JSON.stringify(snapshots)).not.toContain("fake-key");
});

test.each([
  "write",
  "edit",
  "bash",
  "AskUserQuestion",
  "Agent",
  "TaskOutput",
  "browser",
  "RespondToCoordinator",
])("model-requested %s cannot cross the execution allowlist", async (name) => {
  const f = await fixture((_body, index) =>
    index === 0
      ? toolCall(name, { path: "note.txt", content: "pwned", command: "touch pwned" })
      : sse({ content: "blocked" }),
  );
  await run(f.host, "Attempt forbidden tool");
  expect(toolNames(f.requests[0])).not.toContain(name);
  expect(messages(f.requests[1]).find((message) => message.role === "tool")?.content).toMatch(
    /not found|unknown tool/i,
  );
  expect(await readFile(join(f.cwd, "note.txt"), "utf8")).toBe("read-only text");
  expect(await readdir(f.cwd)).not.toContain("pwned");
  expect(f.settings.state.listTasks()).toEqual([]);
});

test("slash commands and file references are ordinary text rather than runtime instructions", async () => {
  const f = await fixture();
  await run(f.host, "/tools write bash @note.txt");
  expect(messages(f.requests[0]).find((message) => message.role === "user")?.content).toBe(
    "/tools write bash @note.txt",
  );
  expect(JSON.stringify(f.requests[0])).not.toContain("read-only text");
  expect(toolNames(f.requests[0])).toEqual(["read", "list", "search"]);
});

test("allowed read runs through the constrained tool rather than the unrestricted core reader", async () => {
  const f = await fixture((_body, index) =>
    index === 0 ? toolCall("read", { path: "note.txt" }) : sse({ content: "done" }),
  );
  await run(f.host);
  expect(messages(f.requests[1]).find((message) => message.role === "tool")?.content).toContain(
    "read-only text",
  );
});

test("web tools are gated by service, credentials and capability on every run and execution", async () => {
  const f = await fixture();
  await run(f.host);
  f.settings.saveWebSearch({ provider: "deepseek", enabled: true, apiKey: "fake-web-key" });
  await run(f.host);
  expect(toolNames(f.requests[1])).toEqual(["read", "list", "search", "web_search", "web_fetch"]);
  f.settings.setCapabilityEnabled("webSearch", false);
  await run(f.host);
  expect(toolNames(f.requests[2])).toEqual(["read", "list", "search"]);
  expect(f.web).toEqual([]);
});

test("model switches preserve in-memory history without changing the main task model selection", async () => {
  const f = await fixture();
  await run(f.host);
  f.host.setSelection({ provider: "chat", modelId: "two", reasoning: "none" });
  await run(f.host, "continue");
  expect(f.requests[1].model).toBe("two");
  expect(messages(f.requests[1]).filter((message) => message.role === "user")).toHaveLength(2);
  expect(f.settings.get().lastSelection?.modelId).toBe("one");
  expect(() => f.host.setSelection({ provider: "chat", modelId: "missing", reasoning: "none" })).toThrow();
});

test("a second send or model switch is rejected while initializing; stop aborts the request and reset clears it", async () => {
  let started!: () => void;
  const pending = new Promise<void>((resolve) => {
    started = resolve;
  });
  const f = await fixture((_body, _index, signal) => {
    started();
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new DOMException("Aborted", "AbortError"));
      signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), {
        once: true,
      });
    });
  });
  f.host.send("slow");
  expect(() => f.host.send("duplicate")).toThrow("busy");
  expect(() => f.host.setSelection({ provider: "chat", modelId: "two", reasoning: "none" })).toThrow("busy");
  await pending;
  await f.host.stop();
  expect(f.host.getSnapshot().session.runs[0].status).toBe("aborted");
  const id = f.host.getSnapshot().session.sessionId;
  await f.host.reset();
  expect(f.host.getSnapshot().session.runs).toEqual([]);
  expect(f.host.getSnapshot().session.sessionId).not.toBe(id);
});

test("reset during initialization is serialized and no late response resurrects the prior conversation", async () => {
  const f = await fixture();
  f.host.send("discard");
  const reset = f.host.reset();
  expect(() => f.host.send("racing")).toThrow("busy");
  await reset;
  expect(f.host.getSnapshot().session.runs).toEqual([]);
  expect(f.requests).toEqual([]);
  await run(f.host, "fresh");
  expect(messages(f.requests[0]).filter((message) => message.role === "user")).toEqual([
    expect.objectContaining({ content: "fresh" }),
  ]);
});

test("closed hosts clear memory, reject new requests, and stop emitting snapshots", async () => {
  const f = await fixture();
  await run(f.host);
  const listener = vi.fn();
  f.host.subscribe(listener);
  await f.host.close();
  expect(f.host.getSnapshot().session.runs).toEqual([]);
  expect(() => f.host.send("late")).toThrow("busy");
  expect(listener).not.toHaveBeenCalled();
});

test("quick-chat web search and fetch execute through the existing provider and return in the same conversation", async () => {
  const f = await fixture((_body, index) =>
    index === 0
      ? toolCall("web_search", { query: "Example" })
      : index === 1
        ? toolCall("web_fetch", { url: "https://example.com/article" })
        : sse({ content: "Answer from source" }),
  );
  f.settings.saveWebSearch({ provider: "deepseek", enabled: true, apiKey: "fake-web-key" });
  await run(f.host, "Find and read the example");
  expect(f.web).toEqual([
    "https://api.deepseek.com/v1/tools/search",
    "https://api.deepseek.com/v1/tools/fetch",
  ]);
  expect(
    messages(f.requests[2])
      .filter((message) => message.role === "tool")
      .map((message) => message.content)
      .join("\n"),
  ).toContain("Fetched public content");
  const snapshot = f.host.getSnapshot();
  expect(snapshot.session.runs).toHaveLength(1);
  expect(JSON.stringify(snapshot.session)).toContain("Answer from source");
  expect(JSON.stringify(snapshot.session)).not.toContain("fake-web-key");
  expect(f.settings.state.listTasks()).toEqual([]);
});

test.each(["capability", "service", "key"])(
  "disabling web %s during generation rejects its pending tool call",
  async (kind) => {
    const f = await fixture((_body, index) => {
      if (index !== 0) return sse({ content: "Web access was disabled" });
      if (kind === "capability") f.settings.setCapabilityEnabled("webSearch", false);
      else if (kind === "service") f.settings.saveWebSearch({ provider: "deepseek", enabled: false });
      else f.settings.saveWebSearch({ provider: "deepseek", apiKey: "" });
      return toolCall("web_search", { query: "Example" });
    });
    f.settings.saveWebSearch({ provider: "deepseek", enabled: true, apiKey: "fake-web-key" });
    await run(f.host);
    expect(toolNames(f.requests[0])).toContain("web_search");
    expect(f.web).toEqual([]);
    expect(messages(f.requests[1]).find((message) => message.role === "tool")?.content).toMatch(
      /credential|enable|configure/i,
    );
  },
);
