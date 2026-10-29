import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import type { AssistantMessage, ModelRetryStatus, TranscriptContext } from "zpi-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { chunk, fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

it.each(["recover", "budget", "cancel"])(
  "honors server backoff beyond the provider cap during session %s",
  async (mode) => {
    let requests = 0;
    const fetcher = vi.fn<typeof fetch>(async () =>
      ++requests === 1
        ? Response.json({ error: { message: "busy" } }, { status: 429, headers: { "retry-after": "120" } })
        : new Response(
            `data: ${JSON.stringify(chunk({ content: "recovered" }))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
            { headers: { "content-type": "text/event-stream" } },
          ),
    );
    const runtime = await ModelRuntime.create({ fetch: fetcher });
    runtime.registerProvider("fake", { baseUrl: "http://local/v1", apiKey: "key", models: [fakeConfig("")] });
    const { session } = await createAgentSession({
      modelRuntime: runtime,
      sessionManager: SessionManager.inMemory(),
      resourceLoader: new StaticResourceLoader(),
      settingsManager: SettingsManager.inMemory({
        retry: { maxElapsedMs: mode === "budget" ? 60000 : 600000 },
        compaction: { enabled: false },
      }),
      noTools: "all",
    });
    const scheduled = Promise.withResolvers<void>();
    const delays: number[] = [];
    session.subscribe((event) => {
      if (event.type === "model_retry" && event.status) {
        delays.push(event.status.retryDelayMs);
        scheduled.resolve();
      }
    });
    vi.useFakeTimers();
    try {
      const running = session.prompt("answer");
      if (mode === "budget") {
        await running;
        expect(delays).toEqual([]);
      } else {
        await scheduled.promise;
        expect(delays).toEqual([120000]);
        if (mode === "cancel") await session.abort();
        else {
          await vi.advanceTimersByTimeAsync(119999);
          expect(fetcher).toHaveBeenCalledTimes(1);
          await vi.advanceTimersByTimeAsync(1);
        }
        await running;
      }
      expect(fetcher).toHaveBeenCalledTimes(mode === "recover" ? 2 : 1);
      expect(session.isIdle).toBe(true);
    } finally {
      session.dispose();
      vi.useRealTimers();
    }
  },
);

it("pairs an unexecuted write with a synthetic failure during streaming recovery, as in ZCode", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  let calls = 0,
    writes = 0;
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, context, options) {
      const events = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      options?.onRetry?.(null);
      if (++calls === 1) {
        const toolCall = {
          type: "toolCall" as const,
          id: "complete-write",
          name: "write",
          arguments: { path: "once.txt", content: "complete" },
        };
        output.content = [{ type: "text", text: "discarded tail" }, toolCall];
        output.stopReason = "error";
        output.errorMessage = "network error: connection reset";
        output.errorDetails = { retryable: true };
        events.push({ type: "start", partial: output });
        events.push({ type: "text_delta", contentIndex: 0, delta: "discarded tail", partial: output });
        events.push({ type: "toolcall_end", contentIndex: 1, toolCall, partial: output });
      } else {
        expect(context.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
        expect(context.messages.find((m) => m.role === "toolResult")).toMatchObject({
          isError: true,
          details: { type: "stream_recovery_interrupted_tool", reason: "not_executed" },
        });
        expect(JSON.stringify(context)).not.toContain("discarded tail");
        output.content = [{ type: "text", text: "finished" }];
        events.push({ type: "start", partial: output });
      }
      events.end(output);
      return events;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    homeDir: join(cwd, "home"),
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ retry: { baseDelayMs: 0 } }),
  });
  session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "write") writes++;
  });
  await session.prompt("write once");
  expect(calls).toBe(2);
  expect(writes).toBe(1);
  await expect(access(join(cwd, "once.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  expect(session.messages.at(-1)).toMatchObject({ content: [{ text: "finished" }] });
  session.dispose();
});

it.each(["network error: connection reset", "net::ERR_QUIC_PROTOCOL_ERROR"])(
  "recovers text and reasoning after %s without replaying writes, retaining failed tails only in history",
  async (errorMessage) => {
    const cwd = await directory();
    const contexts: TranscriptContext[] = [];
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple(model, context, options) {
        contexts.push(structuredClone(context));
        const events = createAssistantMessageEventStream();
        const output = emptyAssistant(model);
        const n = contexts.length;
        if (n === 1) {
          output.content = [
            {
              type: "toolCall",
              id: "write-once",
              name: "write",
              arguments: { path: "once.txt", content: "once" },
            },
          ];
          output.stopReason = "toolUse";
        } else if (n < 5) {
          output.content = [
            { type: "thinking", thinking: "discarded thought" },
            { type: "text", text: "discarded tail" },
          ];
          output.stopReason = "error";
          output.errorMessage = errorMessage;
        } else {
          options?.onRetry?.(null);
          output.content = [{ type: "text", text: "recovered answer" }];
        }
        events.push({ type: "start", partial: output });
        if (n > 1 && n < 5)
          events.push({ type: "text_delta", contentIndex: 1, delta: "discarded tail", partial: output });
        events.end(output);
        return events;
      },
    });
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      homeDir: join(cwd, "home"),
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ retry: { baseDelayMs: 0 } }),
      sessionManager: manager,
    });
    const retry: (ModelRetryStatus | null)[] = [];
    let writes = 0,
      resets = 0,
      starts = 0;
    session.subscribe((event) => {
      if (event.type === "model_retry") retry.push(event.status);
      if (event.type === "tool_execution_start" && event.toolName === "write") writes++;
      if (event.type === "message_start" && event.message.role === "assistant") starts++;
      if (event.type === "message_update" && event.assistantMessageEvent.type === "reset") resets++;
    });
    try {
      await session.prompt("write then respond");
      expect(writes).toBe(1);
      expect(resets).toBe(0);
      expect(starts).toBe(5);
      expect(retry.filter(Boolean).map((s) => s?.attempt)).toEqual([1, 2, 3]);
      expect(retry.at(-1)).toBeNull();
      expect(await readFile(join(cwd, "once.txt"), "utf8")).toBe("once");
      for (const context of contexts.slice(1)) {
        expect(context.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
        expect(JSON.stringify(context)).not.toContain("discarded");
      }
      expect(
        manager
          .getEntries()
          .filter(
            (entry) =>
              entry.type === "message" &&
              entry.message.role === "assistant" &&
              entry.message.stopReason === "error",
          ),
      ).toHaveLength(3);
      expect(JSON.stringify(manager.getEntries())).toContain("discarded");
      expect(session.messages.at(-1)).toMatchObject({
        stopReason: "stop",
        content: [{ text: "recovered answer" }],
      });
    } finally {
      session.dispose();
    }
  },
);

it.each(["text", "thinking", "toolCall"] as const)(
  "clears reconnect status while recovered %s is still streaming without resetting the retry budget",
  async (kind) => {
    const cwd = await directory();
    const runtime = await ModelRuntime.create();
    const streaming = Promise.withResolvers<void>();
    const finish = Promise.withResolvers<void>();
    let calls = 0;
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple(model) {
        const events = createAssistantMessageEventStream();
        const output = emptyAssistant(model);
        calls++;
        events.push({ type: "start", partial: output });
        if (calls < 3) {
          output.stopReason = "error";
          output.errorMessage = "network error: connection reset";
          output.errorDetails = { retryable: true };
          events.end(output);
        } else {
          output.content = [
            kind === "text"
              ? { type: "text", text: "recovered text" }
              : kind === "thinking"
                ? { type: "thinking", thinking: "recovered thought" }
                : { type: "toolCall", id: "recovered-call", name: "read", arguments: {} },
          ];
          events.push({
            type:
              kind === "toolCall" ? "toolcall_start" : kind === "thinking" ? "thinking_start" : "text_start",
            contentIndex: 0,
            partial: output,
          });
          void finish.promise.then(() => {
            // End without executing the partial tool call.
            output.stopReason = "aborted";
            events.end(output);
          });
        }
        return events;
      },
    });
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      homeDir: join(cwd, "home"),
      modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory({ retry: { baseDelayMs: 0 } }),
    });
    const retry: (ModelRetryStatus | null)[] = [];
    session.subscribe((event) => {
      if (event.type === "model_retry") retry.push(event.status);
      if (event.type === "message_update" && calls === 3) streaming.resolve();
    });
    const running = session.prompt("recover while streaming");
    try {
      await streaming.promise;
      expect(session.isStreaming).toBe(true);
      expect(retry.filter(Boolean).map((status) => status?.attempt)).toEqual([1, 2]);
      expect(retry.at(-1)).toBeNull();
    } finally {
      finish.resolve();
      await running;
      session.dispose();
    }
  },
);

it.each(["network error: connection reset", "net::ERR_QUIC_PROTOCOL_ERROR"])(
  "bounds %s partial recovery at ten retries, preserves the final failure and cancels backoff",
  async (errorMessage) => {
    const cwd = await directory();
    const runtime = await ModelRuntime.create();
    let calls = 0;
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple() {
        calls++;
        const events = createAssistantMessageEventStream();
        const output: AssistantMessage = {
          ...emptyAssistant(fakeModel("")),
          content: [{ type: "text", text: "last partial" }],
          stopReason: "error",
          errorMessage,
        };
        events.push({ type: "start", partial: output });
        events.push({ type: "text_delta", contentIndex: 0, delta: "last partial", partial: output });
        events.end(output);
        return events;
      },
    });
    const settings = SettingsManager.inMemory({ retry: { baseDelayMs: 0 } });
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      homeDir: join(cwd, "home"),
      modelRuntime: runtime,
      settingsManager: settings,
    });
    const retries: ModelRetryStatus[] = [];
    session.subscribe((event) => {
      if (event.type === "model_retry" && event.status) retries.push(event.status);
    });
    try {
      await session.prompt("recover");
      expect(calls).toBe(11);
      expect(retries.map((status) => status.attempt)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
      expect(retries.every((status) => status.maxRetries === 10)).toBe(true);
      expect(session.isIdle).toBe(true);
      expect(session.messages.at(-1)).toMatchObject({
        stopReason: "error",
        errorMessage,
        content: [{ text: "last partial" }],
      });
      expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(1);
      settings.applyOverrides({ retry: { baseDelayMs: 60000 } });
      const unsubscribe = session.subscribe((event) => {
        if (event.type === "model_retry" && event.status) void session.abort();
      });
      try {
        await session.prompt("cancel retry");
        expect(calls).toBe(12);
        expect(retries.at(-1)?.attempt).toBe(1);
        expect(session.isIdle).toBe(true);
      } finally {
        unsubscribe();
      }
    } finally {
      session.dispose();
    }
  },
);
