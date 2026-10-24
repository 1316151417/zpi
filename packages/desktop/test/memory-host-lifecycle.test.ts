import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { chunk, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { defaultMemorySettings } from "../src/shared/memory.ts";
import { cleanup, fixture, run } from "./helpers/context-fixture.ts";

test("a successful history edit invalidates old memory evidence after the replacement commits", async () => {
  const f = await fixture();
  await run(f, "ORIGINAL PREFERENCE TO REPLACE");
  const original = f.host.getSessionSnapshot(f.session.id).view.runs.at(-1);
  if (!original) throw new Error("Expected original run");
  const previousPath = f.host.sessionPath(f.session.id);
  const invalidate = f.host.longMemory.invalidateSource.bind(f.host.longMemory);
  let transcriptAtInvalidation = "";
  const invalidation = vi.spyOn(f.host.longMemory, "invalidateSource").mockImplementation(async (id) => {
    expect(f.host.sessionPath(id)).not.toBe(previousPath);
    transcriptAtInvalidation = await readFile(f.host.sessionPath(id), "utf8");
    return invalidate(id);
  });
  await f.host.editUserMessage(f.session.id, original.runId, { text: "REPLACEMENT PREFERENCE" });
  await f.host.activeRuns.get(f.session.id)?.done;
  expect(invalidation).toHaveBeenCalledWith(f.session.id);
  expect(transcriptAtInvalidation).not.toContain("ORIGINAL PREFERENCE TO REPLACE");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs.at(-1)?.userMessage).toBe(
    "REPLACEMENT PREFERENCE",
  );
});

test("a rejected history edit retains the original history and does not withdraw memory", async () => {
  const f = await fixture();
  await run(f, "Preserve this actual request.");
  const original = f.host.getSessionSnapshot(f.session.id).view.runs.at(-1);
  if (!original) throw new Error("Expected original run");
  const previousPath = f.host.sessionPath(f.session.id);
  const bytes = await readFile(previousPath);
  const invalidation = vi.spyOn(f.host.longMemory, "invalidateSource");
  await expect(f.host.editUserMessage(f.session.id, original.runId, { text: "/compact" })).rejects.toThrow(
    "历史消息不能替换为 /compact",
  );
  expect(invalidation).not.toHaveBeenCalled();
  expect(f.host.sessionPath(f.session.id)).toBe(previousPath);
  expect(await readFile(previousPath)).toEqual(bytes);
});

test("deleting a conversation withdraws its memory source before removing durable history", async () => {
  const f = await fixture();
  await run(f, "A source to delete.");
  const invalidate = f.host.longMemory.invalidateSource.bind(f.host.longMemory);
  const invalidation = vi.spyOn(f.host.longMemory, "invalidateSource").mockImplementation(async (id) => {
    expect(f.settings.state.getTask(id)).toBeDefined();
    expect(await readFile(f.host.sessionPath(id), "utf8")).toContain("A source to delete.");
    return invalidate(id);
  });
  await f.host.deleteSession(f.session.id);
  expect(invalidation).toHaveBeenCalledWith(f.session.id);
  expect(f.settings.state.getTask(f.session.id)).toBeUndefined();
  expect(() => f.host.sessionPath(f.session.id)).toThrow();
});

test("application close waits for memory cleanup after stopping foreground runs", async () => {
  const f = await fixture((_, response) => response.flushHeaders());
  await f.host.saveMemorySettings({ ...defaultMemorySettings, long: true });
  const events: string[] = [];
  vi.spyOn(f.host.longMemory, "context").mockImplementation(async () => ({
    instructions: ["Retained memory context"],
    sources: [],
  }));
  vi.spyOn(f.host.longMemory, "check").mockResolvedValue();
  let finishCleanup = () => {};
  const cleanupGate = new Promise<void>((resolve) => {
    finishCleanup = resolve;
  });
  const drain = f.host.longMemory.drain.bind(f.host.longMemory);
  vi.spyOn(f.host.longMemory, "drain").mockImplementation(async () => {
    events.push("memory-drain-start");
    await drain();
    await cleanupGate;
    events.push("memory-drain-done");
  });
  await f.host.startRun({ sessionId: f.session.id, text: "Keep a foreground turn active until shutdown." });
  await vi.waitFor(() => expect(f.server.requests.length).toBeGreaterThan(0));
  events.length = 0;
  let closed = false;
  const closing = f.host.close().then(() => {
    closed = true;
  });
  try {
    await vi.waitFor(() => expect(events).toContain("memory-drain-start"));
    expect(f.host.activeRuns.size).toBe(0);
    expect(closed).toBe(false);
  } finally {
    finishCleanup();
    await closing;
  }
  expect(events).toContain("memory-drain-done");
  expect(f.host.activeRuns.size).toBe(0);
});

test.each(["delete-child", "close-app"])(
  "a child retains the selected parent memory after its parent settles until %s",
  async (action) => {
    const f = await fixture((body, response) => {
      const tools = body.tools as { function: { name: string } }[] | undefined;
      if (tools && !tools.some((tool) => tool.function.name === "Agent")) {
        response.flushHeaders();
        return;
      }
      const messages = body.messages as { role: string }[];
      if (tools && !messages.some((message) => message.role === "tool")) {
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "spawn-child",
                type: "function",
                function: {
                  name: "Agent",
                  arguments: JSON.stringify({
                    description: "Use inherited memory",
                    prompt: "Inspect the inherited memory context.",
                    run_in_background: true,
                  }),
                },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      } else {
        send(response, chunk({ content: "Parent has finished its reply." }));
        done(response);
      }
    });
    await f.host.saveMemorySettings({ ...defaultMemorySettings, long: true });
    vi.spyOn(f.host.longMemory, "context").mockResolvedValue({
      instructions: ["PARENT_SELECTED_MEMORY"],
      sources: [],
    });
    vi.spyOn(f.host.longMemory, "check").mockResolvedValue();
    await run(f, "Delegate a task while using memory.");
    const task = f.host.subagents.list(f.session.id).at(-1);
    if (!task) throw new Error("Expected delegated child");
    await vi.waitFor(() => expect(f.host.activeRuns.has(task.childSessionId)).toBe(true));
    await vi.waitFor(() =>
      expect(f.host.sessions.get(task.childSessionId)?.systemPrompt).toContain("PARENT_SELECTED_MEMORY"),
    );
    if (action === "delete-child") {
      await f.host.subagents.stop(f.session.id, task.agentId);
      expect(f.host.sessions.get(task.childSessionId)?.systemPrompt).toContain("PARENT_SELECTED_MEMORY");
      await f.host.deleteSession(task.childSessionId);
    } else await f.host.close();
    expect(f.host.activeRuns.has(task.childSessionId)).toBe(false);
  },
);

test.each(["clear", "restart"])(
  "resuming a child after %s withdraws stale long memory while preserving inherited short memory",
  async (action) => {
    const f = await fixture((body, response) => {
      const tools = body.tools as { function: { name: string } }[] | undefined;
      const child = tools && !tools.some((tool) => tool.function.name === "Agent");
      if (child) {
        response.flushHeaders();
        return;
      }
      const messages = body.messages as { role: string }[];
      if (!child && tools && !messages.some((message) => message.role === "tool")) {
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "memory-child",
                type: "function",
                function: {
                  name: "Agent",
                  arguments: JSON.stringify({
                    description: "Use selected memory",
                    prompt: "Inspect inherited context.",
                    run_in_background: true,
                  }),
                },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      } else {
        send(response, chunk({ content: "Finished." }));
        done(response);
      }
    });
    await mkdir(join(f.resources, ".zpi"), { recursive: true });
    await writeFile(join(f.resources, ".zpi", "MEMORY.md"), "- [language] RETAINED_SHORT_MEMORY\n");
    await f.host.saveMemorySettings({ ...defaultMemorySettings, short: true, long: true });
    vi.spyOn(f.host.longMemory, "context").mockResolvedValue({
      instructions: ["STALE_LONG_MEMORY"],
      sources: [],
    });
    vi.spyOn(f.host.longMemory, "check").mockResolvedValue();
    await run(f, "Delegate this memory task.");
    const task = f.host.subagents.list(f.session.id).at(-1);
    if (!task) throw new Error("Expected delegated child");
    await vi.waitFor(() =>
      expect(f.host.sessions.get(task.childSessionId)?.systemPrompt).toContain("STALE_LONG_MEMORY"),
    );
    await f.host.subagents.stop(f.session.id, task.agentId);
    let host = f.host;
    if (action === "clear") await host.clearLongMemory();
    else {
      await host.close();
      host = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
      cleanup.push(() => host.close());
      await host.init();
    }
    const context = vi.spyOn(host.longMemory, "context");
    context.mockClear();
    const checks = vi.spyOn(host.longMemory, "check").mockResolvedValue();
    checks.mockClear();
    host.subagents.prepare(f.session.id);
    const sendMessage = host.subagents.tools(f.session.id).find((tool) => tool.name === "SendMessage");
    if (!sendMessage) throw new Error("Missing SendMessage tool");
    await sendMessage.execute(
      "resume",
      { to: task.agentId, summary: "Continue", message: "Use current context." },
      undefined,
      undefined,
      {
        cwd: f.workspace,
        model: fakeModel(f.server.url),
        sessionManager: SessionManager.inMemory(),
        isIdle: () => true,
        getSystemPrompt: () => "",
      },
    );
    await vi.waitFor(() => {
      expect(host.activeRuns.has(task.childSessionId)).toBe(true);
      expect(host.sessions.get(task.childSessionId)?.systemPrompt).toContain("RETAINED_SHORT_MEMORY");
      expect(host.sessions.get(task.childSessionId)?.systemPrompt).not.toContain("STALE_LONG_MEMORY");
    });
    const prompt = host.sessions.get(task.childSessionId)?.systemPrompt;
    expect(prompt).toContain("RETAINED_SHORT_MEMORY");
    expect(prompt).not.toContain("STALE_LONG_MEMORY");
    expect(context).not.toHaveBeenCalled();
    expect(checks).not.toHaveBeenCalled();
    await host.subagents.stop(f.session.id, task.agentId);
  },
);
