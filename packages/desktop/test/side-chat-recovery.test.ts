import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { chunk, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { StreamingToolJournal } from "../../coding-agent/src/core/streaming-tool-journal.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("preserves historical model and non-off thinking in inherited anchors across reopen", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "answer" }));
    done(response);
  });
  f.settings.saveProvider({
    id: "other",
    name: "Other",
    baseUrl: f.server.url,
    apiKey: "test",
    models: [{ id: "other-model", reasoning: true, compat: { supportsReasoningEffort: true } }],
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.setSessionSelection(parent.id, { provider: "custom", modelId: "fake", reasoning: "high" });
  await f.host.startRun({ sessionId: parent.id, text: "first model" });
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.setSessionSelection(parent.id, {
    provider: "other",
    modelId: "other-model",
    reasoning: "medium",
  });
  await f.host.startRun({ sessionId: parent.id, text: "second model" });
  await f.host.activeRuns.get(parent.id)?.done;
  // Current selection must not rewrite the historical cutoff inherited by the child.
  await f.host.setSessionSelection(parent.id, { provider: "custom", modelId: "fake", reasoning: "none" });
  const child = await f.host.createSideChat(parent.id);
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => reopened.close());
  await reopened.init();
  expect(reopened.getSessionSnapshot(child.id).controls.selection).toEqual({
    provider: "other",
    modelId: "other-model",
    reasoning: "medium",
  });
  const index = new HistoryIndex(reopened.sessionPath(child.id), f.settings.state.db);
  await index.load();
  expect(index.getStateAt(index.snapshot())).toMatchObject({
    model: { provider: "other", modelId: "other-model" },
    thinkingLevel: "medium",
    lastThinkingLevel: "medium",
  });
  const first = [...index.readRange(1, index.snapshot().endSeq, index.snapshot())].find(
    ({ entry }) =>
      entry.type === "message" && entry.message.role === "user" && entry.message.content === "first model",
  );
  if (!first) throw new Error("missing first inherited user message");
  expect(index.getStateAt({ ...index.snapshot(), endSeq: first.seq })).toMatchObject({
    model: { provider: "custom", modelId: "fake" },
    thinkingLevel: "high",
    lastThinkingLevel: "high",
  });
});

it("directly creates a side chat after crash recovery without dropping known journal tool results", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "answer" }));
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "prior completed turn" });
  await f.host.activeRuns.get(parent.id)?.done;
  const path = f.host.sessionPath(parent.id);
  await f.host.close();
  const index = new HistoryIndex(path, f.settings.state.db);
  await index.load();
  const manager = SessionManager.fromStore(index);
  manager.appendMessage({ role: "user", content: "interrupted tool turn", timestamp: Date.now() });
  const call = {
    type: "toolCall" as const,
    id: "crash-read",
    name: "read",
    arguments: { path: "README.md" },
  };
  const journal = new StreamingToolJournal(manager, () => {});
  journal.observe({ type: "message_start", message: { ...emptyAssistant(fakeModel("")), content: [call] } });
  journal.observe({
    type: "tool_execution_start",
    toolCallId: call.id,
    toolName: call.name,
    args: call.arguments,
    executionTiming: "during_stream",
  });
  journal.observe({
    type: "tool_execution_end",
    toolCallId: call.id,
    toolName: call.name,
    isError: false,
    result: { content: [{ type: "text", text: "known result before crash" }], details: undefined },
  });
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => reopened.close());
  await reopened.init();
  // Do not open a snapshot or session manager for the parent before this call.
  const child = await reopened.createSideChat(parent.id);
  const childIndex = new HistoryIndex(reopened.sessionPath(child.id), f.settings.state.db);
  await childIndex.load();
  const context = SessionManager.fromStore(childIndex).buildSessionContext();
  const results = context.messages.filter((message) => message.role === "toolResult");
  expect(results).toHaveLength(1);
  expect(results[0]).toMatchObject({
    toolCallId: call.id,
    content: [{ type: "text", text: "known result before crash" }],
  });
  expect(
    context.messages.some(
      (message) =>
        message.role === "assistant" &&
        message.content.some((part) => part.type === "toolCall" && part.id === call.id),
    ),
  ).toBe(true);
  expect(f.server.requests).toHaveLength(1);
});
