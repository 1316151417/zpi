import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, emptyAssistant, type TranscriptContext } from "zpi-ai";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

afterEach(() => vi.useRealTimers());

it("retries only the stalled model request without replaying a completed write", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  const contexts: TranscriptContext[] = [];
  const signals: AbortSignal[] = [];
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, context, options) {
      contexts.push(structuredClone(context));
      if (options?.signal) signals.push(options.signal);
      const events = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      if (contexts.length === 1) {
        output.content = [
          { type: "toolCall", id: "once", name: "write", arguments: { path: "once.txt", content: "once" } },
        ];
        output.stopReason = "toolUse";
        events.end(output);
      } else if (contexts.length === 3) {
        output.content = [{ type: "text", text: "recovered" }];
        events.end(output);
      }
      return events;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: new StaticResourceLoader(),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
  });
  let writes = 0;
  session.subscribe((event) => {
    if (event.type === "tool_execution_start" && event.toolName === "write") writes++;
  });
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
  const running = session.prompt("write once");
  try {
    await vi.waitFor(() => expect(contexts).toHaveLength(2), { interval: 1 });
    expect(session.retryModelRequest()).toBe(true);
    expect(session.retryModelRequest()).toBe(false);
    await vi.advanceTimersByTimeAsync(1_001);
    await running;
    expect(writes).toBe(1);
    expect(await readFile(join(cwd, "once.txt"), "utf8")).toBe("once");
    expect(contexts[2].messages.filter((message) => message.role === "toolResult")).toHaveLength(1);
    expect(signals[1].reason).toMatchObject({ code: "MODEL_REQUEST_RETRY" });
    expect(session.messages.at(-1)).toMatchObject({ content: [{ text: "recovered" }] });
    expect(session.retryModelRequest()).toBe(false);
  } finally {
    session.dispose();
  }
});

it("ends recovery at its absolute deadline despite arriving output and resets the budget for new prompts", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  let calls = 0;
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, _context, options) {
      const events = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      calls++;
      if (calls === 1)
        setTimeout(() => events.end({ ...output, stopReason: "error", errorMessage: "network error" }), 50);
      else if (calls === 2) {
        const timer = setInterval(() => {
          output.content = [{ type: "text", text: "still streaming" }];
          events.push({ type: "text_delta", contentIndex: 0, delta: "still streaming", partial: output });
        }, 25);
        options?.signal?.addEventListener("abort", () => clearInterval(timer), { once: true });
      } else events.end({ ...output, content: [{ type: "text", text: "new prompt" }] });
      return events;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: new StaticResourceLoader(),
    settingsManager: SettingsManager.inMemory({
      streamIdleTimeoutMs: 1_000,
      retry: { baseDelayMs: 0, maxElapsedMs: 250 },
    }),
  });
  vi.useFakeTimers();
  try {
    const running = session.prompt("recover");
    await vi.advanceTimersByTimeAsync(1_400);
    await running;
    expect(calls).toBe(2);
    expect(session.messages.at(-1)).toMatchObject({
      stopReason: "error",
      errorDetails: { code: "MODEL_RECOVERY_DEADLINE" },
    });
    await session.prompt("new prompt");
    expect(calls).toBe(3);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    session.dispose();
  }
});

it("does not spend the recovery budget while a long initial response is producing output", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  let calls = 0;
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model) {
      const events = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      if (++calls === 1) {
        const timer = setInterval(() => {
          output.content = [{ type: "text", text: "initial output" }];
          events.push({ type: "text_delta", contentIndex: 0, delta: "initial output", partial: output });
        }, 25);
        setTimeout(() => {
          clearInterval(timer);
          events.end({ ...output, stopReason: "error", errorMessage: "network error" });
        }, 250);
      } else events.end({ ...output, content: [{ type: "text", text: "recovered" }] });
      return events;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    resourceLoader: new StaticResourceLoader(),
    settingsManager: SettingsManager.inMemory({
      streamIdleTimeoutMs: 100,
      retry: { baseDelayMs: 0, maxElapsedMs: 100 },
    }),
  });
  vi.useFakeTimers();
  try {
    const running = session.prompt("long answer");
    await vi.advanceTimersByTimeAsync(300);
    await running;
    expect(calls).toBe(2);
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop", content: [{ text: "recovered" }] });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    session.dispose();
  }
});

it.each(["request", "backoff"])(
  "retries compaction during %s without cancelling the compact operation",
  async (stage) => {
    const cwd = await directory();
    const runtime = await ModelRuntime.create();
    let calls = 0;
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple(model) {
        const events = createAssistantMessageEventStream();
        const output = {
          ...emptyAssistant(model),
          content: [{ type: "text" as const, text: "summary ".repeat(100) }],
        };
        calls++;
        if (calls !== 2) events.end(output);
        else if (stage === "backoff")
          events.end({ ...output, stopReason: "error", errorMessage: "network error" });
        return events;
      },
    });
    const manager = SessionManager.inMemory(cwd);
    const { session } = await createAgentSession({
      cwd,
      modelRuntime: runtime,
      sessionManager: manager,
      resourceLoader: new StaticResourceLoader(),
      settingsManager: SettingsManager.inMemory({
        retry: { enabled: stage === "backoff", baseDelayMs: 60_000 },
        compaction: { enabled: false, keepRecentTokens: 0 },
      }),
    });
    try {
      await session.prompt("task");
      vi.useFakeTimers();
      const compacting = session.compact();
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(2);
      expect(session.retryModelRequest()).toBe(true);
      await vi.advanceTimersByTimeAsync(1_001);
      await compacting;
      expect(calls).toBe(3);
      expect(manager.getEntries().some((entry) => entry.type === "compaction")).toBe(true);
      expect(session.isIdle).toBe(true);
      expect(session.retryModelRequest()).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      session.dispose();
    }
  },
);
