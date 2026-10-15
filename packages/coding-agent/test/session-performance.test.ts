import { join } from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import type { ModelPerformanceSample } from "zpi-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "zpi-coding-agent";
import { deferred, fakeConfig } from "../../../tests/fake-server.ts";
import { cleanup, directory } from "./helpers/session-fixture.ts";

it("measures the whole prompt through tools/retries, discards cancellation and retains cumulative metrics across prompts and ignores late callbacks", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  const toolStarted = deferred();
  const toolRelease = deferred();
  const cancelledStarted = deferred();
  let late: ((sample: ModelPerformanceSample) => void) | undefined;
  let calls = 0;
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      message.content = [{ type: "text", text: "ok" }];
      options?.onPerformance?.({});
      calls++;
      if (calls === 1) {
        options?.onPerformance?.({ ttftMs: 800, outputTokens: 85, generationMs: 1000 });
        message.content = [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }];
        message.stopReason = "toolUse";
      } else if (calls === 2) {
        options?.onPerformance?.({ ttftMs: 9000, outputTokens: 9000, generationMs: 10 });
        message.stopReason = "error";
        message.errorMessage = "server error";
        message.errorDetails = { retryable: true, status: 503 };
      } else if (calls === 3) {
        options?.onPerformance?.({ ttftMs: 1200, outputTokens: 115, generationMs: 3000 });
      } else if (calls === 4) {
        late = options?.onPerformance;
        late?.({ ttftMs: 9999, outputTokens: 9999, generationMs: 1 });
        cancelledStarted.resolve();
        return stream; // The watchdog/abort path must discard this sample.
      } else {
        // Custom providers without measurements must not change the prior speed.
        late?.({ ttftMs: 9999 });
      }
      stream.end(message);
      return stream;
    },
  });
  const { session } = await createAgentSession({
    cwd,
    homeDir: join(cwd, "home"),
    agentDir: join(cwd, "agent"),
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { baseDelayMs: 0 } }),
    customTools: [
      {
        name: "wait",
        label: "Wait",
        description: "test tool",
        parameters: Type.Object({}),
        execute: async () => {
          toolStarted.resolve();
          await toolRelease.promise;
          return { content: [{ type: "text", text: "done" }], details: undefined };
        },
      },
    ],
  });
  cleanup.push(async () => {
    toolRelease.resolve();
    session.dispose();
  });
  const running = session.prompt("go");
  await toolStarted.promise;
  expect(session.modelPerformance).toMatchObject({ ttftMs: 800, tokensPerSecond: 85 });
  toolRelease.resolve();
  await running;
  expect(calls).toBe(3);
  expect(session.modelPerformance).toMatchObject({ ttftMs: 1000, tokensPerSecond: 50 });
  const cancelled = session.prompt("cancel");
  expect(session.modelPerformance).toMatchObject({ ttftMs: 1000, tokensPerSecond: 50 });
  await cancelledStarted.promise;
  await session.abort();
  await cancelled;
  expect(session.modelPerformance).toMatchObject({ ttftMs: 1000, tokensPerSecond: 50 });
  await session.prompt("again");
  expect(session.modelPerformance).toMatchObject({ ttftMs: 1000, tokensPerSecond: 50 });
});
