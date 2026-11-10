import { join } from "node:path";
import type { ModelPerformanceSample } from "@zpi-dev/ai";
import { createAssistantMessageEventStream, emptyAssistant } from "@zpi-dev/ai";
import { createAgentSession, ModelRuntime, SessionManager, SettingsManager } from "@zpi-dev/coding-agent";
import { Type } from "typebox";
import { expect, it } from "vitest";
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
      message.content = [{ type: "text", text: "ok".repeat(200) }];
      message.usageAvailable = true;
      message.usage.reasoning = 0;
      message.usage.output = calls === 2 ? 115 : 85;
      options?.onPerformance?.({});
      calls++;
      if (calls === 1) {
        options?.onPerformance?.({ ttftMs: 800, requestMs: 1800, outputTokens: 85, hasToolCalls: true });
        message.content = [{ type: "toolCall", id: "wait-1", name: "wait", arguments: {} }];
        message.stopReason = "toolUse";
      } else if (calls === 2) {
        options?.onPerformance?.({ ttftMs: 9000, outputTokens: 9000, generationMs: 10 });
        message.stopReason = "error";
        message.errorMessage = "server error";
        message.errorDetails = { retryable: true, status: 503 };
      } else if (calls === 3) {
        options?.onPerformance?.({
          ttftMs: 1200,
          requestMs: 4300,
          firstTextMs: 1200,
          textGenerationMs: 3000,
          outputTokens: 115,
          textChunks: 4,
          textChars: 400,
          largestTextChunk: 100,
        });
      } else if (calls === 4) {
        late = options?.onPerformance;
        late?.({ ttftMs: 9999, outputTokens: 9999, generationMs: 1 });
        cancelledStarted.resolve();
        return stream; // The watchdog/abort path must discard this sample.
      } else {
        // An unmeasured request must not fabricate another qualified speed sample.
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
  expect(session.modelPerformance).toMatchObject({ ttftMs: 800, speedSampleCount: 0 });
  expect(session.modelPerformance.tokensPerSecond).toBeUndefined();
  toolRelease.resolve();
  await running;
  expect(calls).toBe(3);
  expect(session.modelPerformance).toMatchObject({
    ttftMs: 1200,
    tokensPerSecond: 115 / 3,
    speedSampleCount: 1,
  });
  const cancelled = session.prompt("cancel");
  expect(session.modelPerformance).toMatchObject({
    ttftMs: 1200,
    tokensPerSecond: 115 / 3,
    speedSampleCount: 1,
  });
  await cancelledStarted.promise;
  await session.abort();
  await cancelled;
  expect(session.modelPerformance).toMatchObject({
    ttftMs: 1200,
    tokensPerSecond: 115 / 3,
    speedSampleCount: 1,
  });
  await session.prompt("again");
  expect(session.modelPerformance).toMatchObject({ tokensPerSecond: 115 / 3, speedSampleCount: 1 });
  expect(session.modelPerformance.ttftMs).toBeUndefined();
});
