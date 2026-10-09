import {
  createAssistantMessageEventStream,
  emptyAssistant,
  getCurrentSystemPrompt,
  type SimpleStreamOptions,
} from "ZPI-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "ZPI-coding-agent";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import {
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  prepareCompaction,
  shouldCompact,
} from "../src/core/compaction.ts";
import { serializeConversation } from "../src/core/compaction-utils.ts";
import { directory } from "./helpers/session-fixture.ts";

it("uses strict thresholds and identical manual/automatic cuts, preserving oversized tool batches", async () => {
  expect(shouldCompact(83616, 100000, DEFAULT_COMPACTION_SETTINGS)).toBe(false);
  expect(shouldCompact(83617, 100000, DEFAULT_COMPACTION_SETTINGS)).toBe(true);
  const manager = SessionManager.inMemory();
  manager.appendMessage({ role: "user", content: "short", timestamp: 1 });
  expect(prepareCompaction(manager.getEntries(), DEFAULT_COMPACTION_SETTINGS)).toBeUndefined();
  const call = {
    ...emptyAssistant(fakeModel("")),
    content: [{ type: "toolCall" as const, id: "read", name: "read", arguments: { path: "x" } }],
    stopReason: "toolUse" as const,
  };
  const kept = manager.appendMessage(call);
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "read",
    toolName: "read",
    content: [{ type: "text", text: "x".repeat(20000) }],
    timestamp: 2,
    isError: false,
  });
  const prep = prepareCompaction(manager.getEntries(), {
    ...DEFAULT_COMPACTION_SETTINGS,
    keepRecentTokens: 10,
  });
  expect(prep).toMatchObject({
    firstKeptEntryId: kept,
    isSplitTurn: true,
    messagesToSummarize: [],
    turnPrefixMessages: [{ role: "user", content: "short" }],
  });
  expect(serializeConversation(manager.buildSessionContext().messages)).toContain(
    "18000 more characters truncated",
  );
});

it("merges old summaries, uses 80%/50% budgets and inherits reasoning with no summary cache", async () => {
  const model = { ...fakeModel(""), maxTokens: 10000 };
  const manager = SessionManager.inMemory();
  const old = manager.appendMessage({ role: "user", content: "old request", timestamp: 1 });
  manager.appendCompaction("previous checkpoint", old, 50, {
    readFiles: ["old-read"],
    modifiedFiles: ["changed"],
  });
  manager.appendMessage({
    ...emptyAssistant(model),
    content: [{ type: "toolCall", id: "edit", name: "edit", arguments: { path: "old-read" } }],
    stopReason: "toolUse",
  });
  manager.appendMessage({
    role: "toolResult",
    toolCallId: "edit",
    toolName: "edit",
    content: [{ type: "text", text: "edited" }],
    isError: false,
    timestamp: 2,
  });
  manager.appendMessage({ role: "user", content: "new request", timestamp: 3 });
  const kept = manager.appendMessage({
    ...emptyAssistant(model),
    content: [{ type: "text", text: "recent ".repeat(1000) }],
    stopReason: "stop",
  });
  const prep = prepareCompaction(manager.getEntries(), {
    ...DEFAULT_COMPACTION_SETTINGS,
    reserveTokens: 1000,
    keepRecentTokens: 10,
  });
  if (!prep) throw new Error("Missing preparation");
  expect(prep.firstKeptEntryId).toBe(kept);
  const requests: { context: string; options: SimpleStreamOptions | undefined }[] = [];
  const result = await compact(
    prep,
    model,
    undefined,
    undefined,
    "keep decisions",
    undefined,
    "high",
    (m, context, options) => {
      requests.push({ context: JSON.stringify(context), options });
      const events = createAssistantMessageEventStream();
      const message = {
        ...emptyAssistant(m),
        stopReason: "stop" as const,
        content: [{ type: "text" as const, text: requests.length === 1 ? "updated history" : "turn prefix" }],
      };
      events.end(message);
      return events;
    },
  );
  expect(requests.map((r) => r.options?.maxTokens)).toEqual([800, 500]);
  expect(requests[0].context).toContain("<previous-summary>");
  expect(requests[0].context).toContain("previous checkpoint");
  for (const request of requests)
    expect(request.options).toMatchObject({ reasoning: "high", cacheRetention: "none" });
  expect(requests[0].options?.sessionId).toMatch(/^[\da-f-]{36}$/);
  expect(result.summary).toContain("**Turn Context (split turn):**");
  expect(result.details).toEqual({ readFiles: [], modifiedFiles: ["changed", "old-read"] });
});

it("compacts repeatedly between tool turns within one user request and keeps each next request projected", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "x"), "tool result ".repeat(1500));
  let turns = 0;
  const contexts: string[] = [];
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    models: [{ ...fakeConfig(""), contextWindow: 10000 }],
    streamSimple(model, context) {
      const summary = getCurrentSystemPrompt(context.messages).startsWith(
        "You are a context summarization assistant.",
      );
      const events = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      if (summary) output.content = [{ type: "text", text: "checkpoint" }];
      else {
        contexts.push(JSON.stringify(context));
        turns++;
        output.timestamp = Date.now() + turns;
        output.usage.totalTokens = 100;
        output.usage.input = 100;
        output.content =
          turns <= 3
            ? [{ type: "toolCall", id: `read${turns}`, name: "read", arguments: { path: "x" } }]
            : [{ type: "text", text: "done" }];
        output.stopReason = turns <= 3 ? "toolUse" : "stop";
      }
      events.push({ type: "start", partial: output });
      events.end(output);
      return events;
    },
  });
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    modelRuntime: runtime,
    sessionManager: manager,
    resourceLoader: new StaticResourceLoader(),
    tools: ["read"],
    compaction: { reserveTokens: 7000, keepRecentTokens: 10 },
  });
  try {
    await session.prompt("read three times then answer");
    expect(turns).toBe(4);
    expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(3);
    expect(contexts.slice(1).every((context) => context.includes("Summary of earlier conversation:"))).toBe(
      true,
    );
    expect(contexts[3]).not.toContain('"id":"read1"');
    expect(session.messages).toEqual(manager.buildSessionContext().messages);
    expect(manager.getEntries().findLast((entry) => entry.type === "compaction")).toMatchObject({
      details: { readFiles: ["x"], modifiedFiles: [] },
    });
  } finally {
    session.dispose();
  }
});

it("history queries share records but not their array, and project only the latest checkpoint", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "system",
    content: "instructions",
    sections: { "ZPI.goal": "legacy", keep: "kept" },
    timestamp: 1,
  });
  const discarded = manager.appendMessage({ role: "user", content: "old payload", timestamp: 2 });
  const first = manager.appendMessage({ role: "user", content: "first kept", timestamp: 3 });
  manager.appendCompaction("first checkpoint", first);
  const last = manager.appendMessage({ role: "user", content: "last kept", timestamp: 4 });
  manager.appendCompaction("latest checkpoint", last);
  const entries = manager.getEntries();
  expect(manager.getEntries()).not.toBe(entries);
  expect(manager.getEntries()[0]).toBe(entries[0]);
  entries.pop();
  expect(manager.getEntries()).toHaveLength(entries.length + 1);
  const context = manager.buildSessionContext().messages;
  expect(JSON.stringify(context)).not.toContain("old payload");
  expect(JSON.stringify(context)).not.toContain("first checkpoint");
  const keptEntry = manager.getEntries().find((entry) => entry.id === last);
  expect(keptEntry?.type).toBe("message");
  if (keptEntry?.type === "message") expect(context.at(-1)).toBe(keptEntry.message);
  expect(JSON.stringify(context)).not.toContain("legacy");
  expect(JSON.stringify(manager.getEntries()[0])).toContain("legacy");
  expect(manager.getEntries().some((entry) => entry.id === discarded)).toBe(true);
});

it.each(["overflow", "length", "successful overflow"])(
  "handles %s using one consecutive recovery budget",
  async (kind) => {
    const cwd = await directory();
    let requests = 0;
    let summaries = 0;
    const runtime = await ModelRuntime.create();
    const model = { ...fakeModel(""), contextWindow: 10000 };
    runtime.registerProvider("fake", {
      models: [{ ...fakeConfig(""), contextWindow: 10000 }],
      streamSimple(m, context) {
        const message = emptyAssistant(m);
        if (
          getCurrentSystemPrompt(context.messages).startsWith("You are a context summarization assistant.")
        ) {
          summaries++;
          message.content = [{ type: "text", text: "summary" }];
        } else {
          requests++;
          message.timestamp = Date.now() + requests;
          message.content = [{ type: "text", text: "partial" }];
          if (kind === "overflow") {
            message.stopReason = "error";
            message.errorMessage = "maximum context length is 2000 tokens";
          } else if (kind === "length") {
            message.stopReason = "length";
            message.usage.output = 1;
          } else {
            message.stopReason = "stop";
            message.usage.input = 10001;
          }
        }
        const events = createAssistantMessageEventStream();
        events.end(message);
        return events;
      },
    });
    const manager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      modelRuntime: runtime,
      model,
      sessionManager: manager,
      noTools: "all",
      resourceLoader: new StaticResourceLoader(),
      compaction: { keepRecentTokens: 0 },
    });
    try {
      await session.prompt("request");
      expect(summaries).toBe(1);
      expect(requests).toBe(kind === "successful overflow" ? 1 : 2);
      expect(manager.getEntries().filter((entry) => entry.type === "compaction")).toHaveLength(1);
      if (kind !== "successful overflow")
        expect(
          manager
            .getEntries()
            .filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
        ).toHaveLength(2);
    } finally {
      session.dispose();
    }
  },
);

it("retries whole failed turns three times and cancels backoff without erasing durable failures", async () => {
  const cwd = await directory();
  let requests = 0;
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model) {
      requests++;
      const events = createAssistantMessageEventStream();
      events.end({ ...emptyAssistant(model), stopReason: "error", errorMessage: "503 busy" });
      return events;
    },
  });
  const manager = SessionManager.inMemory(cwd);
  const settings = SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { baseDelayMs: 0, provider: { maxRetries: 0 } },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: settings,
    resourceLoader: new StaticResourceLoader(),
    noTools: "all",
  });
  const attempts: number[] = [];
  session.subscribe((event) => {
    if (event.type === "model_retry" && event.status) attempts.push(event.status.attempt);
  });
  try {
    await session.prompt("retry");
    expect(requests).toBe(4);
    expect(attempts).toEqual([1, 2, 3]);
    expect(
      manager.getEntries().filter((entry) => entry.type === "message" && entry.message.role === "assistant"),
    ).toHaveLength(4);
    expect(session.messages.filter((message) => message.role === "assistant")).toHaveLength(1);
    settings.applyOverrides({ retry: { baseDelayMs: 60000 } });
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "model_retry" && event.status) void session.abort();
    });
    await session.prompt("cancel retry");
    unsubscribe();
    expect(requests).toBe(5);
    expect(session.isIdle).toBe(true);
    settings.applyOverrides({ retry: { enabled: false } });
    await session.prompt("no agent retry");
    expect(requests).toBe(6);
  } finally {
    session.dispose();
  }
});
