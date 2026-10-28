import { copyFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AssistantMessage, Message, ToolCall } from "zpi-ai";
import { createAssistantMessageEventStream, emptyAssistant, normalizeContext } from "zpi-ai";
import {
  createAgentSession,
  ModelRuntime,
  projectStreamedToolJournal,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import { responsesInput } from "../../ai/src/api/openai-responses.ts";
import { restoreView } from "../../desktop/src/main/projection.ts";
import { StreamingToolJournal } from "../src/core/streaming-tool-journal.ts";
import { directory } from "./helpers/session-fixture.ts";

async function fixture() {
  const cwd = await directory();
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendCustomEntry("zpi.run", { phase: "start", runId: "r", text: "read", startedAt: 1 });
  manager.appendMessage({ role: "user", content: "read", timestamp: 1 });
  const call: ToolCall = { type: "toolCall", id: "read", name: "read", arguments: { path: "README.md" } };
  const second: ToolCall = { ...call, id: "second" };
  const message: AssistantMessage = {
    ...emptyAssistant(fakeModel("")),
    content: [
      { type: "text", text: "discarded text" },
      { type: "thinking", thinking: "discarded reasoning" },
      call,
      second,
    ],
  };
  const journal = new StreamingToolJournal(manager, () => {});
  await journal.observe({ type: "message_start", message });
  const start = (id = call.id) =>
    journal.observe({
      type: "tool_execution_start",
      toolCallId: id,
      toolName: "read",
      args: call.arguments,
      executionTiming: "during_stream",
    });
  const end = (id = call.id) =>
    journal.observe({
      type: "tool_execution_end",
      toolCallId: id,
      toolName: "read",
      isError: false,
      result: { content: [{ type: "text", text: `result:${id}` }], details: undefined },
    });
  return { manager, journal, message, call, second, start, end, file: manager.getSessionFile() as string };
}

for (const completed of [false, true]) {
  it(`restores ${completed ? "a completed" : "an unresolved"} streamed call after a crash without rerunning it`, async () => {
    const f = await fixture();
    await f.start();
    if (completed) await f.end();
    const before = await readFile(f.file, "utf8");
    expect(before).toContain("zpi.streaming_tools");
    expect(before).not.toContain("discarded");
    const entries = f.manager.getEntries();
    const snapshot = structuredClone(entries);
    const view = restoreView("s", "read", entries);
    expect(view.runs[0]).toMatchObject({
      status: "interrupted",
      orderedBlocks: [
        { type: "tool", toolCallId: "read", status: completed ? "completed" : "error", isError: !completed },
      ],
    });
    expect(entries).toEqual(snapshot);
    const reopened = SessionManager.open(f.file);
    const messages = reopened.buildSessionContext().messages;
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    const results = messages.filter((m) => m.role === "toolResult");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject(
      completed
        ? { isError: false, content: [{ text: "result:read" }] }
        : { isError: true, details: { reason: "unknown_execution_state" } },
    );
    const recovered = await readFile(f.file, "utf8");
    SessionManager.open(f.file);
    expect(await readFile(f.file, "utf8")).toBe(recovered);
    expect(restoreView("s", "read", reopened.getEntries()).runs[0].orderedBlocks).toEqual(
      view.runs[0].orderedBlocks,
    );
  });
}

it("merges independent call records in declaration order and recovers the gap after assistant commit", async () => {
  const f = await fixture();
  await f.start();
  await f.start("second");
  await f.end("second");
  await f.end();
  const final = {
    ...f.message,
    content: f.message.content.filter((c) => c.type === "toolCall"),
    stopReason: "toolUse" as const,
  };
  f.manager.appendMessage(final);
  f.manager.appendMessage({
    role: "toolResult",
    toolCallId: "read",
    toolName: "read",
    content: [{ type: "text", text: "result:read" }],
    isError: false,
    timestamp: 1,
  });
  const projected = projectStreamedToolJournal(f.manager.getEntries());
  expect(projected.filter((e) => e.type === "message" && e.message.role === "assistant")).toHaveLength(1);
  expect(
    projected.flatMap((e) =>
      e.type === "message" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
    ),
  ).toEqual(["read", "second"]);
  const reopened = SessionManager.open(f.file);
  expect(
    reopened
      .buildSessionContext()
      .messages.filter((m) => m.role === "toolResult")
      .map((m) => m.toolCallId),
  ).toEqual(["read", "second"]);
  expect(reopened.buildSessionContext().messages.filter((m) => m.role === "assistant")).toHaveLength(1);
});

for (const canonical of [false, true]) {
  it(`restores mixed streamed and deferred calls in declaration order ${canonical ? "after" : "before"} assistant commit`, async () => {
    const f = await fixture();
    await f.start("second");
    await f.end("second");
    const final = { ...f.message, stopReason: "toolUse" as const };
    await f.journal.observe({ type: "message_end", message: final });
    if (canonical) f.manager.appendMessage(final);
    const entries = f.manager.getEntries();
    const projected = projectStreamedToolJournal(entries);
    expect(
      projected.flatMap((e) =>
        e.type === "message" && e.message.role === "toolResult" ? [e.message.toolCallId] : [],
      ),
    ).toEqual(["read", "second"]);
    const reopened = SessionManager.open(f.file);
    const messages = reopened.buildSessionContext().messages;
    expect(messages.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(messages.filter((m) => m.role === "toolResult")).toMatchObject([
      { toolCallId: "read", isError: true, details: { reason: "unknown_execution_state" } },
      { toolCallId: "second", isError: false, content: [{ text: "result:second" }] },
    ]);
    const recovered = await readFile(f.file, "utf8");
    SessionManager.open(f.file);
    expect(await readFile(f.file, "utf8")).toBe(recovered);
  });
}

it("checkpoints calls supplied only by the final response before any execution starts", async () => {
  const f = await fixture();
  await f.journal.observe({ type: "message_start", message: emptyAssistant(fakeModel("")) });
  await f.journal.observe({ type: "message_end", message: f.message });
  f.manager.appendMessage(f.message);
  await f.journal.observe({
    type: "tool_execution_start",
    toolCallId: f.second.id,
    toolName: f.second.name,
    args: f.second.arguments,
  });
  await f.end("second");
  expect(
    SessionManager.open(f.file)
      .buildSessionContext()
      .messages.filter((m) => m.role === "toolResult"),
  ).toMatchObject([
    { toolCallId: "read", isError: true },
    { toolCallId: "second", isError: false },
  ]);
});

it("checkpoints the closed declaration instead of a stale partial with the same call ID", async () => {
  const f = await fixture();
  const closed: ToolCall = {
    ...f.call,
    arguments: { path: "final-input.txt" },
    namespace: "custom-provider",
    thoughtSignature: "provider-signature",
  };
  await f.journal.observe({
    type: "tool_execution_start",
    toolCallId: closed.id,
    toolName: closed.name,
    args: closed.arguments,
    toolCall: closed,
  });
  const recovered = SessionManager.open(f.file).buildSessionContext().messages;
  expect(recovered.find((message) => message.role === "assistant")?.content).toEqual([closed]);
});

it("a committed journal does not resurrect calls or add model messages", async () => {
  const f = await fixture();
  await f.start();
  await f.end();
  await f.journal.observe({ type: "turn_end", message: f.message, toolResults: [] });
  const before = await readFile(f.file, "utf8");
  expect(projectStreamedToolJournal(f.manager.getEntries())).toEqual(f.manager.getEntries());
  SessionManager.open(f.file);
  expect(await readFile(f.file, "utf8")).toBe(before);
});

it.each(["error", "length", "aborted"] as const)(
  "closes final-only tool calls after an empty initial partial and a %s response",
  async (stopReason) => {
    const cwd = await directory();
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const runtime = await ModelRuntime.create();
    let requests = 0;
    runtime.registerProvider("fake", {
      models: [{ ...fakeConfig(""), api: "openai-responses" }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        // Immutable custom providers need not mutate or re-emit the initial partial.
        stream.push({ type: "start", partial: emptyAssistant(model) });
        const firstResponse = requests++ === 0;
        stream.end({
          ...emptyAssistant(model),
          stopReason: firstResponse ? stopReason : "stop",
          content: firstResponse
            ? ["first", "second"].map((id) => ({
                type: "toolCall" as const,
                id,
                name: "unexecuted",
                namespace: "custom-provider",
                thoughtSignature: "provider-signature",
                arguments: { input: id },
              }))
            : [{ type: "text", text: "Recovered normally" }],
        });
        return stream;
      },
    });
    const { session } = await createAgentSession({
      modelRuntime: runtime,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      }),
      resourceLoader: new StaticResourceLoader(),
      noTools: "all",
    });
    let checkpointMessages: Message[] | undefined;
    session.subscribe((event) => {
      if (event.type !== "tool_execution_start" || event.toolCallId !== "first") return;
      // Capture durable bytes before the terminal assistant reaches message_end.
      const checkpoint = join(cwd, "before-message-end.jsonl");
      copyFileSync(manager.getSessionFile() as string, checkpoint);
      checkpointMessages = SessionManager.open(checkpoint).buildSessionContext().messages;
    });
    try {
      await session.prompt("Exercise a final-only tool declaration");
      expect(checkpointMessages?.find((message) => message.role === "assistant")).toMatchObject({
        content: [{ id: "first", namespace: "custom-provider", thoughtSignature: "provider-signature" }],
      });
      expect(
        responsesInput(session.model, normalizeContext({ messages: checkpointMessages ?? [] })),
      ).toContainEqual({
        type: "function_call",
        call_id: "first",
        name: "unexecuted",
        namespace: "custom-provider",
        arguments: JSON.stringify({ input: "first" }),
      });
      const messages = manager.buildSessionContext().messages;
      const declaration = messages.findLast((message) => message.role === "assistant");
      expect(declaration).toMatchObject({
        stopReason,
        content: ["first", "second"].map((id) => ({ id, namespace: "custom-provider" })),
      });
      expect(
        manager
          .getEntries()
          .find(
            (entry) =>
              entry.type === "custom" &&
              entry.customType === "zpi.streaming_tools" &&
              (entry.data as { responseComplete?: boolean })?.responseComplete,
          ),
      ).toMatchObject({ data: { assistant: declaration } });
      expect(messages.filter((message) => message.role === "toolResult")).toMatchObject([
        { toolCallId: "first", isError: true, details: { reason: "not_executed" } },
        { toolCallId: "second", isError: true, details: { reason: "not_executed" } },
      ]);
      expect(projectStreamedToolJournal(manager.getEntries())).toEqual(manager.getEntries());
      expect(SessionManager.open(manager.getSessionFile() as string).buildSessionContext().messages).toEqual(
        messages,
      );
      // A journal bookkeeping failure must not leave the session permanently faulted.
      await session.prompt("Continue the session");
      expect(session.messages.at(-1)).toMatchObject({ content: [{ text: "Recovered normally" }] });
      expect(session.isIdle).toBe(true);
    } finally {
      session.dispose();
    }
  },
);

it("recovers only the unresolved declaration when a later turn reuses an ID", async () => {
  const { recoverCanonicalToolCalls } = await import("../src/core/streaming-tool-journal.ts");
  const manager = SessionManager.inMemory();
  const assistant: AssistantMessage = {
    ...emptyAssistant(fakeModel("")),
    content: [{ type: "toolCall", id: "same", name: "read", arguments: {} }],
  };
  const result: Message = {
    role: "toolResult",
    toolCallId: "same",
    toolName: "read",
    content: [],
    isError: false,
    timestamp: 0,
  };
  manager.appendMessage(assistant);
  manager.appendMessage(result);
  manager.appendMessage(assistant);
  recoverCanonicalToolCalls(manager, manager.buildSessionContext().messages);
  expect(
    manager.buildSessionContext().messages.filter((message) => message.role === "toolResult"),
  ).toMatchObject([{ isError: false }, { isError: true }]);
});
