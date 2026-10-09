import { emptyAssistant } from "ZPI-ai";
import { SessionManager } from "ZPI-coding-agent";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { StreamingToolJournal } from "../../coding-agent/src/core/streaming-tool-journal.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("reconciles crash-recovered streamed tool pairs with history offsets before continuing the desktop session", async () => {
  const f = await fixture((body, response) => {
    expect(body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "tool", tool_call_id: "read", content: "read before crash" }),
      ]),
    );
    send(response, chunk({ content: "continued" }));
    done(response);
  });
  const id = f.host.createSession(f.a.id).id;
  await f.host.close();
  const file = join(f.dir, "agent", "sessions", f.a.id, `${id}.jsonl`);
  const manager = SessionManager.open(file);
  manager.appendCustomEntry("ZPI.run", {
    phase: "start",
    runId: "interrupted",
    text: "read",
    startedAt: 1,
    agentBoundaries: true,
  });
  manager.appendCustomEntry("ZPI.agent_call", { phase: "start", ordinal: 0 });
  manager.appendMessage({ role: "user", content: "read", timestamp: 1 });
  const call = { type: "toolCall" as const, id: "read", name: "read", arguments: { path: "README.md" } };
  const message = { ...emptyAssistant(fakeModel(f.server.url)), content: [call] };
  const journal = new StreamingToolJournal(manager, () => {});
  journal.observe({ type: "message_start", message });
  journal.observe({
    type: "tool_execution_start",
    toolCallId: "read",
    toolName: "read",
    args: call.arguments,
    executionTiming: "during_stream",
  });
  journal.observe({
    type: "tool_execution_end",
    toolCallId: "read",
    toolName: "read",
    isError: false,
    result: { content: [{ type: "text", text: "read before crash" }], details: undefined },
  });
  const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  cleanup.push(() => host.close());
  await host.init();
  expect(host.getSessionSnapshot(id).view.runs[0]).toMatchObject({
    status: "interrupted",
    orderedBlocks: [{ type: "tool", toolCallId: "read", status: "completed", output: "read before crash" }],
  });
  await host.startRun({ sessionId: id, text: "continue" });
  await host.activeRuns.get(id)?.done;
  expect(host.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
  await host.close();
  const index = new HistoryIndex(file);
  await index.load();
  expect(index.data.diagnostic).toBeUndefined();
  const entries = index.page().entries;
  expect(entries.filter((e) => e.type === "message" && e.message.role === "toolResult")).toHaveLength(1);
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  cleanup.push(() => reopened.close());
  await reopened.init();
  expect(reopened.getSessionSnapshot(id).view.runs[0].orderedBlocks).toHaveLength(1);
  expect(reopened.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
});
