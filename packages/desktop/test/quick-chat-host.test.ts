import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, expect, test, vi } from "vitest";
import type { JsonObject } from "zpi-ai";
import { chunk } from "../../../tests/fake-server.ts";
import { QUICK_CHAT_IDLE_MS, QuickChatHost } from "../src/main/quick-chat-host.ts";
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
  now?: () => number,
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
                  site_icon: "https://cdn.example.com/icon.png",
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
  const host = new QuickChatHost(settings, cwd, transport, now);
  cleanups.push(() => host.close());
  return { dir, cwd, settings, host, requests, web };
}
async function run(host: QuickChatHost, text = "hello") {
  host.send(text);
  await host.waitForIdle();
}
function enableImages(settings: SettingsStore) {
  settings.saveProvider({
    ...settings.snapshot("chat"),
    models: [
      { id: "one", reasoning: false, input: ["text", "image"] },
      { id: "two", reasoning: false, input: ["text"] },
    ],
  });
}
const pastedImage = () =>
  sharp({ create: { width: 3, height: 2, channels: 4, background: "red" } })
    .png()
    .toBuffer();

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
  expect(toolNames(f.requests[0])).toEqual(["read", "bash"]);
  expect(JSON.stringify(f.requests)).not.toContain("DO NOT LOAD PROJECT SENTINEL");
  expect(messages(f.requests[1]).filter((message) => message.role === "user")).toHaveLength(2);
  expect(f.settings.state.listTasks()).toEqual([]);
  expect(await readdir(f.cwd, { recursive: true })).toEqual(before);
  expect(JSON.stringify(snapshots)).not.toContain("fake-key");
});

test.each([
  "write",
  "edit",
  "list",
  "search",
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
  expect(toolNames(f.requests[0])).toEqual(["read", "bash"]);
});

test("core read is reused without a second quick-chat file tool implementation", async () => {
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
  expect(toolNames(f.requests[1])).toEqual(["read", "bash", "web_search", "web_fetch"]);
  f.settings.setCapabilityEnabled("webSearch", false);
  await run(f.host);
  expect(toolNames(f.requests[2])).toEqual(["read", "bash"]);
  expect(f.web).toEqual([]);
});

test("default model changes preserve in-memory history without changing the main task model selection", async () => {
  const f = await fixture();
  await run(f.host);
  f.settings.saveQuickChatSettings({
    defaultSelection: { provider: "chat", modelId: "two", reasoning: "none" },
  });
  f.host.refreshSettings();
  await run(f.host, "continue");
  expect(f.requests[1].model).toBe("two");
  expect(messages(f.requests[1]).filter((message) => message.role === "user")).toHaveLength(2);
  expect(f.settings.get().lastSelection?.modelId).toBe("one");
  expect(() =>
    f.settings.saveQuickChatSettings({
      defaultSelection: { provider: "chat", modelId: "missing", reasoning: "none" },
    }),
  ).toThrow();
});

test("a second send is rejected while initializing; stop aborts the request and reset clears it", async () => {
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

test("default changes during a run apply to the next send without interrupting the active request", async () => {
  let finish!: (response: Response) => void;
  const f = await fixture((_body, index) =>
    index === 0
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : sse({ content: "next answer" }),
  );
  f.host.send("first");
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  f.settings.saveQuickChatSettings({
    defaultSelection: { provider: "chat", modelId: "two", reasoning: "none" },
  });
  f.host.refreshSettings();
  expect(f.host.getSnapshot().selection?.modelId).toBe("one");
  expect(f.host.getSnapshot().session.runs[0].status).toBe("running");
  expect(f.requests[0].model).toBe("one");
  finish(sse({ content: "first finished" }));
  await f.host.waitForIdle();
  expect(f.host.getSnapshot().session.runs[0].status).toBe("completed");
  await run(f.host, "next");
  expect(f.requests[1].model).toBe("two");
  expect(f.settings.get().lastSelection?.modelId).toBe("one");
});

test("disabled or removed defaults fall back deterministically and no model produces an actionable error", async () => {
  const f = await fixture();
  f.settings.rememberSelection({ provider: "chat", modelId: "two", reasoning: "none" });
  f.host.refreshSettings();
  expect(f.host.getSnapshot().selection?.modelId).toBe("one");
  f.settings.saveQuickChatSettings({
    defaultSelection: { provider: "chat", modelId: "two", reasoning: "none" },
  });
  f.settings.saveProvider({
    ...f.settings.snapshot("chat"),
    models: [
      { id: "one", reasoning: false },
      { id: "two", reasoning: false, enabled: false },
    ],
  });
  f.host.refreshSettings();
  await run(f.host);
  expect(f.requests[0].model).toBe("one");
  f.settings.deleteProvider("chat");
  f.host.refreshSettings();
  expect(f.host.getSnapshot().selection).toBeNull();
  expect(() => f.host.send("no models")).toThrow("设置中启用可用模型");
  expect(f.host.getSnapshot().session.runs).toHaveLength(1);
});

test("expiry is based on the last accepted send, not settings, generation, or repeated opens", async () => {
  let now = 100;
  const f = await fixture(undefined, () => now);
  const initial = f.host.getSnapshot().session.sessionId;
  now += QUICK_CHAT_IDLE_MS * 2;
  expect(f.host.resetIfExpired()).toBeUndefined();
  expect(f.host.getSnapshot().session.sessionId).toBe(initial);
  await run(f.host);
  const sentAt = now;
  now += QUICK_CHAT_IDLE_MS - 1;
  f.host.refreshSettings();
  expect(f.host.resetIfExpired()).toBeUndefined();
  expect(f.host.getSnapshot().session.runs).toHaveLength(1);
  expect(() => f.host.send(" ")).toThrow("invalid_input");
  now = sentAt + QUICK_CHAT_IDLE_MS;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().session.sessionId).not.toBe(initial);
  expect(f.host.getSnapshot().session.runs).toHaveLength(0);
  const empty = f.host.getSnapshot().session.sessionId;
  now += QUICK_CHAT_IDLE_MS * 3;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().session.sessionId).toBe(empty);
});

test("accepted follow-up renews expiry and manual reset uses latest default", async () => {
  let now = 0;
  const f = await fixture(undefined, () => now);
  await run(f.host);
  const id = f.host.getSnapshot().session.sessionId;
  now = QUICK_CHAT_IDLE_MS - 1;
  await run(f.host, "follow-up");
  now = QUICK_CHAT_IDLE_MS;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().session.sessionId).toBe(id);
  f.settings.saveQuickChatSettings({
    defaultSelection: { provider: "chat", modelId: "two", reasoning: "none" },
  });
  now += QUICK_CHAT_IDLE_MS;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().selection?.modelId).toBe("two");
  await run(f.host, "new conversation");
  expect(messages(f.requests[2]).filter((message) => message.role === "user")).toHaveLength(1);
  expect(f.requests[2].model).toBe("two");
  await f.host.reset();
  const empty = f.host.getSnapshot().session.sessionId;
  now += QUICK_CHAT_IDLE_MS * 10;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().session.sessionId).toBe(empty);
  expect(f.settings.get().lastSelection?.modelId).toBe("one");
});

test("backward or invalid injected clocks do not spuriously expire a conversation", async () => {
  let now = QUICK_CHAT_IDLE_MS;
  const f = await fixture(undefined, () => now);
  await run(f.host);
  const id = f.host.getSnapshot().session.sessionId;
  for (const value of [-1, Number.NaN, Number.POSITIVE_INFINITY, QUICK_CHAT_IDLE_MS * 2 - 1]) {
    now = value;
    await f.host.resetIfExpired();
    expect(f.host.getSnapshot().session.sessionId).toBe(id);
  }
  now = QUICK_CHAT_IDLE_MS * 2;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().session.sessionId).not.toBe(id);
});

test("expired opening cancels a delayed active request, shares reset, and rejects its late reply", async () => {
  let now = 0;
  let finish!: (value: Response) => void;
  let signal!: AbortSignal;
  const f = await fixture(
    (_body, index, requestSignal) => {
      signal = requestSignal;
      return index === 0
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : sse({ content: "fresh answer" });
    },
    () => now,
  );
  f.host.send("old prompt");
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  now = QUICK_CHAT_IDLE_MS - 1;
  expect(() => f.host.send("busy send")).toThrow("busy");
  now = QUICK_CHAT_IDLE_MS;
  const expired = f.host.resetIfExpired();
  const duplicate = f.host.resetIfExpired();
  expect(signal.aborted).toBe(true);
  finish(sse({ content: "old late answer" }));
  await Promise.all([expired, duplicate]);
  expect(f.host.getSnapshot().session.runs).toHaveLength(0);
  await run(f.host, "fresh prompt");
  expect(JSON.stringify(f.host.getSnapshot())).not.toContain("old late answer");
  expect(messages(f.requests[1]).filter((message) => message.role === "user")).toHaveLength(1);
});

test("icons are authorized from quick search records and pending replies are discarded on reset/close", async () => {
  const f = await fixture((_body, index) =>
    index % 2 === 0 ? toolCall("web_search", { query: "Example" }) : sse({ content: "answer" }),
  );
  f.settings.saveWebSearch({ provider: "deepseek", enabled: true, apiKey: "fake-web-key" });
  await run(f.host);
  let snapshot = f.host.getSnapshot();
  const load = vi.fn(async () => "data:image/png;base64,SAFE");
  const source = "https://example.com/article";
  expect(
    await f.host.readWebSourceIcon(snapshot.session.sessionId, snapshot.session.runs[0].runId, source, load),
  ).toContain("SAFE");
  expect(load).toHaveBeenCalledWith("https://cdn.example.com/icon.png", expect.any(AbortSignal));
  load.mockClear();
  for (const [id, runId, url] of [
    ["main-session", snapshot.session.runs[0].runId, source],
    [snapshot.session.sessionId, "other-run", source],
    [snapshot.session.sessionId, snapshot.session.runs[0].runId, "https://arbitrary.example/"],
  ]) {
    expect(await f.host.readWebSourceIcon(id, runId, url, load)).toBeUndefined();
  }
  expect(load).not.toHaveBeenCalled();
  let finish!: (value: string) => void;
  let signal!: AbortSignal;
  const pendingLoad = vi.fn((_url: string, abort: AbortSignal) => {
    signal = abort;
    return new Promise<string>((resolve) => {
      finish = resolve;
    });
  });
  const pending = f.host.readWebSourceIcon(
    snapshot.session.sessionId,
    snapshot.session.runs[0].runId,
    source,
    pendingLoad,
  );
  await f.host.reset();
  expect(signal.aborted).toBe(true);
  finish("data:image/png;base64,OLD");
  expect(await pending).toBeUndefined();
  expect(
    await f.host.readWebSourceIcon(snapshot.session.sessionId, snapshot.session.runs[0].runId, source, load),
  ).toBeUndefined();
  await run(f.host);
  snapshot = f.host.getSnapshot();
  const closing = f.host.readWebSourceIcon(
    snapshot.session.sessionId,
    snapshot.session.runs[0].runId,
    source,
    pendingLoad,
  );
  await f.host.close();
  expect(signal.aborted).toBe(true);
  finish("data:image/png;base64,CLOSED");
  expect(await closing).toBeUndefined();
});

test("ordinary core bash runs within the default base and is prompt-read-only rather than a command sandbox", async () => {
  const f = await fixture((_body, index) =>
    index === 0
      ? toolCall("bash", { command: "pwd; printf 'shell result'", timeout: 5 })
      : sse({ content: "done" }),
  );
  await run(f.host);
  expect(toolNames(f.requests[0])).toEqual(["read", "bash"]);
  const result = messages(f.requests[1]).find((message) => message.role === "tool")?.content;
  expect(result).toContain(f.cwd);
  expect(result).toContain("shell result");
  expect(messages(f.requests[0]).find((message) => message.role === "system")?.content).toMatch(/read.only/i);
  expect(f.settings.state.listTasks()).toEqual([]);
});

test("the default working directory is created only by an accepted send", async () => {
  const f = await fixture();
  await rm(f.cwd, { recursive: true });
  f.host.getSnapshot();
  f.host.refreshSettings();
  await f.host.resetIfExpired();
  await expect(readdir(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  await run(f.host);
  expect(await readdir(f.cwd)).toEqual([]);
});

test("an expired invocation waits for an already pending manual reset instead of rejecting busy", async () => {
  let now = 0;
  let finish!: (value: Response) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
    () => now,
  );
  f.host.send("slow");
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  now = QUICK_CHAT_IDLE_MS;
  const manual = f.host.reset();
  const reopen = f.host.resetIfExpired();
  finish(sse({ content: "discard me" }));
  await Promise.all([manual, reopen]);
  expect(f.host.getSnapshot().session.runs).toHaveLength(0);
});

test("expiry cancels a running core bash command and its late output cannot enter the fresh session", async () => {
  let now = 0;
  const f = await fixture(
    (_body, index) =>
      index === 0
        ? toolCall("bash", {
            command: "printf 'command started'; sleep 30; printf 'stale output'",
            timeout: 60,
          })
        : sse({ content: "fresh answer" }),
    () => now,
  );
  f.host.send("inspect");
  await vi.waitFor(() => expect(JSON.stringify(f.host.getSnapshot().session)).toContain("command started"));
  now = QUICK_CHAT_IDLE_MS;
  await f.host.resetIfExpired();
  expect(f.host.getSnapshot().session.runs).toHaveLength(0);
  await run(f.host, "fresh");
  const snapshot = JSON.stringify(f.host.getSnapshot().session);
  expect(snapshot).toContain("fresh answer");
  expect(snapshot).not.toContain("command started");
  expect(snapshot).not.toContain("stale output");
});

test("core bash retains its optional timeout without adding a command allowlist", async () => {
  const f = await fixture((_body, index) =>
    index === 0
      ? toolCall("bash", { command: "sleep 30", timeout: 0.05 })
      : sse({ content: "timed out safely" }),
  );
  await run(f.host);
  expect(messages(f.requests[1]).find((message) => message.role === "tool")?.content).toMatch(
    /timed out|timeout/i,
  );
});

test("quit joins a pending manual reset without resurrecting state or accepting old icon reads", async () => {
  let finish!: (value: Response) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  f.host.send("pending");
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  const reset = f.host.reset();
  const close = f.host.close();
  finish(sse({ content: "late after quit" }));
  await Promise.all([reset, close]);
  expect(f.host.getSnapshot().session.runs).toEqual([]);
  expect(() => f.host.send("after quit")).toThrow("关闭");
  const load = vi.fn(async () => "data:image/png;base64,OLD");
  expect(await f.host.readWebSourceIcon("old", "old", "https://example.com/article", load)).toBeUndefined();
  expect(load).not.toHaveBeenCalled();
});

test("pasted images and image-only sends reach multimodal requests while previews stay memory-only", async () => {
  const f = await fixture();
  enableImages(f.settings);
  const before = await readdir(f.dir, { recursive: true });
  const bytes = await pastedImage();
  const image = await f.host.importAttachment(f.host.sessionId, "pasted.jpg", bytes);
  const id = f.host.sessionId;
  expect(image).toMatchObject({ mimeType: "image/png", size: bytes.length, width: 3, height: 2 });
  expect(f.host.readAttachment(id, image.id)).toEqual({ metadata: image, data: bytes.toString("base64") });
  f.host.send("  describe this  ", [image.id]);
  expect(f.host.getSnapshot().session.runs[0]).toMatchObject({
    userMessage: "describe this",
    attachments: [image],
  });
  await f.host.waitForIdle();
  f.host.send("", [image.id]);
  await f.host.waitForIdle();
  expect(f.host.getSnapshot().session.runs[1]).toMatchObject({
    userMessage: "",
    attachments: [image],
    status: "completed",
  });
  await run(f.host, "follow up");
  const requests = JSON.stringify(f.requests);
  expect(requests).toContain("image_url");
  expect(requests).toContain(`data:image/png;base64,${bytes.toString("base64")}`);
  expect(messages(f.requests[2]).filter((message) => message.role === "user")).toHaveLength(3);
  const snapshot = JSON.stringify(f.host.getSnapshot());
  expect(snapshot).not.toContain("base64");
  expect(snapshot).not.toContain(bytes.toString("base64"));
  expect(f.settings.state.listTasks()).toEqual([]);
  expect(await readdir(f.dir, { recursive: true })).toEqual(before);
});

test("non-image models reject fresh images and image history synchronously without consuming drafts or renewing expiry", async () => {
  let now = 0;
  const f = await fixture(undefined, () => now);
  const image = await f.host.importAttachment(f.host.sessionId, "image.png", await pastedImage());
  expect(() => f.host.send("inspect", [image.id])).toThrow("当前模型不支持图片");
  expect(f.host.getSnapshot().session.runs).toHaveLength(0);
  expect(f.host.readAttachment(f.host.sessionId, image.id)).toBeDefined();
  enableImages(f.settings);
  f.host.send("inspect", [image.id]);
  await f.host.waitForIdle();
  f.settings.saveQuickChatSettings({
    defaultSelection: { provider: "chat", modelId: "two", reasoning: "none" },
  });
  now = QUICK_CHAT_IDLE_MS - 1;
  expect(() => f.host.send("text-only follow-up")).toThrow("历史中的图片也需要图片模型");
  expect(f.requests).toHaveLength(1);
  expect(f.host.getSnapshot().session.runs).toHaveLength(1);
  now = QUICK_CHAT_IDLE_MS;
  await f.host.resetIfExpired();
  expect(() => f.host.readAttachment(f.host.sessionId, image.id)).toThrow("not_found:");
  await run(f.host, "fresh text-only conversation");
  expect(f.requests[1].model).toBe("two");
});

test("invalid and foreign image IDs fail before run acceptance; accepted image removal cannot race an active request", async () => {
  let finish!: (response: Response) => void;
  const f = await fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  enableImages(f.settings);
  const id = f.host.sessionId;
  const image = await f.host.importAttachment(id, "image.png", await pastedImage());
  for (const ids of [
    [image.id, image.id],
    ["unknown"],
    ["../outside"],
    Array.from({ length: 9 }, () => image.id),
  ])
    expect(() => f.host.send("inspect", ids)).toThrow();
  await expect(f.host.importAttachment("main-session", "image.png", await pastedImage())).rejects.toThrow(
    "not_found:",
  );
  expect(() => f.host.readAttachment("main-session", image.id)).toThrow("not_found:");
  expect(() => f.host.removeAttachment("main-session", image.id)).toThrow("not_found:");
  expect(f.host.getSnapshot().session.runs).toHaveLength(0);
  f.host.send("inspect", [image.id]);
  expect(() => f.host.send("duplicate", [image.id])).toThrow("busy:");
  f.host.removeAttachment(id, image.id);
  expect(f.host.readAttachment(id, image.id)).toBeDefined();
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  finish(sse({ content: "image answered" }));
  await f.host.waitForIdle();
  expect(f.host.getSnapshot().session.runs[0].status).toBe("completed");
  await f.host.reset();
  expect(() => f.host.send("old image", [image.id])).toThrow("not_found:");
});

test("a failed model request retains its image records for a later retry", async () => {
  const f = await fixture((_body, index) =>
    index === 0
      ? Response.json({ error: { message: "test invalid input" } }, { status: 400 })
      : sse({ content: "retry succeeded" }),
  );
  enableImages(f.settings);
  const image = await f.host.importAttachment(f.host.sessionId, "image.png", await pastedImage());
  f.host.send("inspect", [image.id]);
  await f.host.waitForIdle();
  expect(f.host.getSnapshot().session.runs[0].status).toBe("error");
  expect(f.host.readAttachment(f.host.sessionId, image.id)).toBeDefined();
  f.host.send("inspect", [image.id]);
  await f.host.waitForIdle();
  expect(f.host.getSnapshot().session.runs[1].status).toBe("completed");
  expect(JSON.stringify(f.requests[1])).toContain("data:image/png;base64,");
});

test.each(["reset", "expiry", "close"] as const)(
  "%s invalidates pending image imports and clears all old previews",
  async (kind) => {
    let now = 0;
    const f = await fixture(undefined, () => now);
    const bytes = await pastedImage();
    await run(f.host);
    const id = f.host.sessionId;
    const image = await f.host.importAttachment(id, "image.png", bytes);
    const pending = f.host.importAttachment(id, "late.png", bytes);
    const rejected = expect(pending).rejects.toThrow("临时对话已结束");
    now = QUICK_CHAT_IDLE_MS;
    await (kind === "expiry" ? f.host.resetIfExpired() : f.host[kind]());
    await rejected;
    expect(() => f.host.readAttachment(id, image.id)).toThrow();
    expect(() => f.host.readAttachment(f.host.sessionId, image.id)).toThrow();
    expect(f.host.getSnapshot().session.runs).toHaveLength(0);
  },
);

test("image imports neither create the working base nor renew the last accepted send timestamp", async () => {
  let now = 0;
  const f = await fixture(undefined, () => now);
  await rm(f.cwd, { recursive: true });
  const image = await f.host.importAttachment(f.host.sessionId, "unsent.png", await pastedImage());
  await expect(readdir(f.cwd)).rejects.toMatchObject({ code: "ENOENT" });
  now = QUICK_CHAT_IDLE_MS * 2;
  expect(f.host.resetIfExpired()).toBeUndefined();
  expect(f.host.readAttachment(f.host.sessionId, image.id)).toBeDefined();
  await run(f.host);
  now += QUICK_CHAT_IDLE_MS - 1;
  await f.host.importAttachment(f.host.sessionId, "next-draft.png", await pastedImage());
  now++;
  await f.host.resetIfExpired();
  expect(() => f.host.readAttachment(f.host.sessionId, image.id)).toThrow("not_found:");
});

test("renderer draft loss clears orphaned imports without changing the session or its accepted image history", async () => {
  const f = await fixture();
  enableImages(f.settings);
  const id = f.host.sessionId;
  const bytes = await pastedImage();
  const accepted = await f.host.importAttachment(id, "accepted.png", bytes);
  f.host.send("inspect", [accepted.id]);
  await f.host.waitForIdle();
  const draft = await f.host.importAttachment(id, "draft.png", bytes);
  const pending = f.host.importAttachment(id, "late.png", bytes);
  const rejection = expect(pending).rejects.toThrow("临时对话已结束");
  f.host.discardDraftAttachments();
  await rejection;
  expect(f.host.sessionId).toBe(id);
  expect(f.host.getSnapshot().session.runs).toHaveLength(1);
  expect(f.host.readAttachment(id, accepted.id).metadata).toEqual(accepted);
  expect(() => f.host.readAttachment(id, draft.id)).toThrow("not_found:");
  await run(f.host, "follow up");
  expect(JSON.stringify(f.requests[1])).toContain("data:image/png;base64,");
  await expect(
    Promise.all(Array.from({ length: 8 }, () => f.host.importAttachment(id, "fresh.png", bytes))),
  ).resolves.toHaveLength(8);
});
