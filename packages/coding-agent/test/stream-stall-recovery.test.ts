import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import type { ModelRetryStatus, TranscriptContext } from "zpi-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

afterEach(() => vi.useRealTimers());

it("recovers stalled streams from the last committed tool result, grows the window by 30s and never replays writes", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  const started = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
  const signals: AbortSignal[] = [];
  const contexts: TranscriptContext[] = [];
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, context, options) {
      contexts.push(structuredClone(context));
      const output = emptyAssistant(model);
      const events = createAssistantMessageEventStream();
      if (contexts.length === 1) {
        output.content = [
          {
            type: "toolCall",
            id: "write-once",
            name: "write",
            arguments: { path: "once.txt", content: "once" },
          },
        ];
        output.stopReason = "toolUse";
        events.end(output);
      } else if (contexts.length <= 3) {
        output.content = [{ type: "text", text: "discarded stalled tail" }];
        events.push({ type: "start", partial: output });
        events.push({
          type: "text_delta",
          contentIndex: 0,
          delta: "discarded stalled tail",
          partial: output,
        });
        if (!options?.signal) throw new Error("Missing attempt signal");
        signals.push(options.signal);
        started[contexts.length - 2].resolve();
        // Deliberately ignore abort and never end the stream.
      } else {
        output.content = [{ type: "text", text: "recovered" }];
        events.end(output);
      }
      return events;
    },
  });
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    homeDir: join(cwd, "home"),
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ streamIdleTimeoutMs: 100, retry: { baseDelayMs: 0 } }),
  });
  const retry: (ModelRetryStatus | null)[] = [];
  let writes = 0;
  session.subscribe((event) => {
    if (event.type === "model_retry") retry.push(event.status);
    if (event.type === "tool_execution_start" && event.toolName === "write") writes++;
  });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  const running = session.prompt("write once then answer");
  try {
    await vi.waitFor(() => expect(contexts).toHaveLength(2), { interval: 1 });
    await started[0].promise;
    await vi.advanceTimersByTimeAsync(1_101);
    await vi.waitFor(() => expect(contexts).toHaveLength(3), { interval: 1 });
    await started[1].promise;
    expect(signals[0].reason).toMatchObject({ timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(30_000);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_102);
    await vi.waitFor(() => expect(session.isIdle).toBe(true), { interval: 1 });
    await running;
    expect(signals[1].reason).toMatchObject({ timeoutMs: 30_100 });
    expect(writes).toBe(1);
    expect(await readFile(join(cwd, "once.txt"), "utf8")).toBe("once");
    expect(contexts).toHaveLength(4);
    for (const context of contexts.slice(2)) {
      expect(JSON.stringify(context)).not.toContain("discarded stalled tail");
      expect(context.messages.filter((m) => m.role === "toolResult")).toHaveLength(1);
    }
    expect(retry.filter(Boolean).map((s) => s?.attempt)).toEqual([1, 2]);
    expect(retry.at(-1)).toBeNull();
    expect(session.messages.at(-1)).toMatchObject({ content: [{ text: "recovered" }] });
    const failures = manager
      .getEntries()
      .flatMap((e) =>
        e.type === "message" && e.message.role === "assistant" && e.message.errorDetails
          ? [e.message.errorDetails]
          : [],
      );
    expect(failures.map((f) => f.timeoutMs)).toEqual([100, 30_100]);
    expect(session.isIdle).toBe(true);
  } finally {
    session.dispose();
  }
});

it("applies the same watchdog and growing retry window to compaction", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  let requests = 0;
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model) {
      const events = createAssistantMessageEventStream();
      const output = emptyAssistant(model);
      output.content = [{ type: "text", text: "summary ".repeat(100) }];
      requests++;
      if (requests === 1) events.end(output);
      else if (requests === 3) setTimeout(() => events.end(output), 200);
      return events;
    },
  });
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    homeDir: join(cwd, "home"),
    modelRuntime: runtime,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({
      streamIdleTimeoutMs: 100,
      retry: { baseDelayMs: 0, maxRetries: 1 },
      compaction: { enabled: false, keepRecentTokens: 0 },
    }),
  });
  try {
    await session.prompt("task");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const compacting = session.compact();
    await vi.waitFor(() => expect(requests).toBe(2), { interval: 1 });
    await vi.advanceTimersByTimeAsync(1_400);
    await vi.waitFor(() => expect(session.isIdle).toBe(true), { interval: 1 });
    await compacting;
    expect(requests).toBe(3);
    expect(manager.getEntries().some((e) => e.type === "compaction")).toBe(true);
    expect(session.isIdle).toBe(true);
  } finally {
    session.dispose();
  }
});

it("does not apply the model idle window to a running bash command", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  let requests = 0;
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model) {
      const output = emptyAssistant(model);
      output.content =
        ++requests === 1
          ? [
              {
                type: "toolCall",
                id: "slow-command",
                name: "bash",
                arguments: { command: "sleep 0.1; printf finished", timeout: 5 },
              },
            ]
          : [{ type: "text", text: "done" }];
      output.stopReason = requests === 1 ? "toolUse" : "stop";
      const events = createAssistantMessageEventStream();
      events.end(output);
      return events;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    homeDir: join(cwd, "home"),
    modelRuntime: runtime,
    settingsManager: SettingsManager.inMemory({ streamIdleTimeoutMs: 10 }),
  });
  try {
    await session.prompt("run a command");
    expect(requests).toBe(2);
    expect(session.messages.find((m) => m.role === "toolResult")).toMatchObject({
      content: [{ text: "finished" }],
    });
    expect(session.messages.at(-1)).toMatchObject({ stopReason: "stop" });
  } finally {
    session.dispose();
  }
});
