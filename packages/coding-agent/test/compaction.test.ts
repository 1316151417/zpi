import { emptyAssistant, type Message } from "ZPI-ai";
import { createAgentSession, ModelRuntime, SessionManager, StaticResourceLoader } from "ZPI-coding-agent";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { chunk, done, fakeConfig, fakeModel, fakeServer, send } from "../../../tests/fake-server.ts";
import {
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  prepareCompaction,
} from "../src/core/compaction.ts";
import { fixture } from "./helpers/resource-fixture.ts";

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
it("Pi estimates usage plus trailing text and both image sources; compaction cuts preserve tool batches", () => {
  const model = fakeModel("http://localhost");
  const messages: Message[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "abcd" },
        { type: "image", data: "x", mimeType: "image/png" },
      ],
      timestamp: 1,
    },
    {
      role: "toolResult",
      toolCallId: "read",
      toolName: "read",
      content: [{ type: "image", data: "x", mimeType: "image/png" }],
      isError: false,
      timestamp: 2,
    },
  ];
  expect(estimateContextTokens(messages).tokens).toBe(2401);
  const reply = emptyAssistant(model);
  reply.stopReason = "stop";
  reply.usage.input = 800;
  reply.usage.cacheRead = 200;
  reply.usageAvailable = true;
  expect(
    estimateContextTokens([...messages, reply, { role: "user", content: "x".repeat(9606), timestamp: 3 }]),
  ).toMatchObject({ tokens: 3402, usageTokens: 1000, trailingTokens: 2402, lastUsageIndex: 2 });
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "old", timestamp: 0 });
  const call = {
    ...emptyAssistant(model),
    stopReason: "toolUse" as const,
    content: [{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "x" } }],
  };
  const callId = manager.appendMessage(call);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "read",
    toolName: "read",
    content: [{ type: "text", text: "x".repeat(4000) }],
    isError: false,
    timestamp: 2,
  });
  const boundary = prepareCompaction(manager.getEntries(), {
    ...DEFAULT_COMPACTION_SETTINGS,
    keepRecentTokens: 10,
  });
  expect(boundary?.firstKeptEntryId).toBe(callId);
  manager.appendCompaction("summary", callId);
  expect(manager.buildSessionContext().messages.map((m) => m.role)).toEqual([
    "system",
    "user",
    "assistant",
    "toolResult",
  ]);
});

it("auto compacts before requests and after tools, writes replayable summaries; overflow recovers only once", async () => {
  let overflow = false;
  let repeatOverflow = false;
  const server = await fakeServer((body, response) => {
    const text = JSON.stringify(body.messages);
    if (text.includes("ONLY output the structured summary")) {
      expect(body.tools).toBeUndefined();
      expect(text).toMatch(/## Constraints & Preferences|## Original Request/);
      send(response, chunk({ content: "## Goal\nContinue task\n## Progress\nRead x" }));
      done(response);
    } else if (overflow) {
      if (!repeatOverflow) overflow = false;
      response.writeHead(400, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: { message: "maximum context length is 2000 tokens", type: "invalid_request_error" },
        }),
      );
    } else if (!text.includes("Summary of earlier conversation")) {
      send(
        response,
        chunk({
          tool_calls: [
            { index: 0, id: "read", type: "function", function: { name: "read", arguments: '{"path":"x"}' } },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  cleanups.push(server.close);
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    apiKey: "",
    baseUrl: server.url,
    models: [{ ...fakeConfig(server.url), contextWindow: 10000 }],
  });
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "old ".repeat(5000), timestamp: 1 });
  manager.appendMessage({
    ...emptyAssistant(fakeModel(server.url)),
    stopReason: "stop",
    content: [{ type: "text", text: "old answer" }],
  });
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    sessionManager: manager,
    resourceLoader: new StaticResourceLoader(),
    noTools: "all",
    compaction: { reserveTokens: 8000, keepRecentTokens: 20 },
  });
  cleanups.push(async () => session.dispose());
  const notices: string[] = [];
  session.subscribe((e) => {
    if (e.type === "command_result") notices.push(e.message);
  });
  await session.prompt("new task");
  expect(manager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
  expect(notices.join()).toContain("已自动压缩");
  expect(manager.buildSessionContext().messages).toEqual(session.messages);
  expect(
    manager
      .getEntries()
      .some(
        (e) =>
          e.type === "message" &&
          typeof e.message.content === "string" &&
          e.message.content.startsWith("old old"),
      ),
  ).toBe(true);
  expect(server.requests[1].messages).not.toEqual(server.requests[0].messages);
  // A large completed tool result crosses the next request's threshold without another user prompt.
  const dir = await mkdtemp(join(tmpdir(), "ZPI-compact-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, "x"), "tool result ".repeat(2000));
  const toolManager = SessionManager.inMemory(dir);
  const toolSession = (
    await createAgentSession({
      cwd: dir,
      modelRuntime: runtime,
      sessionManager: toolManager,
      resourceLoader: new StaticResourceLoader(),
      compaction: { reserveTokens: 7000, keepRecentTokens: 10 },
      tools: ["read"],
    })
  ).session;
  cleanups.push(async () => toolSession.dispose());
  await toolSession.prompt("read x then answer");
  expect(toolManager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(1);
  expect(toolManager.getEntries().findLast((e) => e.type === "compaction")).toMatchObject({
    details: { readFiles: [], modifiedFiles: [] },
  });
  const effective = toolManager.buildSessionContext().messages;
  expect(effective.some((m) => m.role === "assistant" && m.content.some((c) => c.type === "toolCall"))).toBe(
    true,
  );
  expect(effective.some((m) => m.role === "toolResult")).toBe(true);
  // The provider reports overflow despite the configured capacity; retry only the model request.
  await session.setModel({ ...session.model, contextWindow: 1000000 });
  overflow = true;
  await session.prompt("continue ".repeat(30));
  expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "stop" });
  const before = manager.getEntries().filter((e) => e.type === "compaction").length;
  overflow = repeatOverflow = true;
  await session.prompt("another request ".repeat(30));
  expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error" });
  expect(manager.getEntries().filter((e) => e.type === "compaction")).toHaveLength(before + 1);
});

it("compaction keeps full history, pairs tools, invalidates usage and survives reopen", async () => {
  const f = await fixture((body, r) => {
    const compacting = JSON.stringify(body.messages).includes("ONLY output the structured summary");
    send(r, chunk({ content: compacting ? "Earlier work summary" : `answer ${"long text ".repeat(100)}` }));
    send(r, {
      ...chunk({}),
      choices: [],
      usage: {
        prompt_tokens: 120,
        completion_tokens: 10,
        total_tokens: 130,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    });
    done(r);
  });
  await expect(f.session.compact()).rejects.toThrow("完整对话");
  f.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 200 } });
  await f.session.prompt("old task");
  await f.session.prompt("recent task");
  const before = f.manager.getEntries().filter((e) => e.type === "message").length;
  expect(f.session.getContextUsage().inputTokens).toBe(120);
  const compactions: unknown[] = [];
  f.session.subscribe((event) => {
    if (event.type === "compaction") compactions.push(event);
  });
  await f.session.compact("keep decisions");
  expect(compactions).toMatchObject([
    { type: "compaction", status: "running", origin: "manual" },
    { type: "compaction", status: "completed", origin: "manual" },
  ]);
  expect(compactions[0]).toHaveProperty("id", (compactions[1] as { id: string }).id);
  expect(f.manager.getEntries().filter((e) => e.type === "message")).toHaveLength(before);
  expect(f.session.getContextUsage().inputTokens).toBeNull();
  expect(f.session.messages.some((m) => m.role === "user" && m.content === "old task")).toBe(false);
  expect(JSON.stringify(f.session.messages)).toContain("Earlier work summary");
  expect(f.server.requests.at(-1)?.tools).toBeUndefined();
  expect(f.server.requests.some((request) => JSON.stringify(request).includes("keep decisions"))).toBe(true);
  const reopened = SessionManager.open(f.manager.getSessionFile() as string);
  expect(reopened.buildSessionContext()).toEqual(f.manager.buildSessionContext());
  const requestCount = f.server.requests.length;
  await f.session.submit("/compact");
  expect(compactions.at(-1)).toMatchObject({ status: "noop", origin: "manual" });
  expect(f.server.requests).toHaveLength(requestCount);
  await f.session.prompt("after compact");
  expect(f.session.getContextUsage().inputTokens).toBe(120);
});
