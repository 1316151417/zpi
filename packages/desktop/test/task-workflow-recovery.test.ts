import { expect, it, vi } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture, run } from "./helpers/context-fixture.ts";

it("restart does not replay an accepted queued input after dequeue writes fail and a later turn completes", async () => {
  const gate = deferred();
  const f = await fixture(async (_, response, index) => {
    send(response, chunk({ content: "ok" }));
    if (index === 0) await gate.promise;
    done(response);
  });
  const id = f.session.id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await f.host.submitInput({ sessionId: id, text: "once only" });
  const queueRuntime = f.host.inputQueue as unknown as {
    runtime: { save: (id: string, queue: { items: unknown[] }) => void };
  };
  const originalSave = queueRuntime.runtime.save;
  const failedSave = vi.spyOn(queueRuntime.runtime, "save").mockImplementation((id, queue) => {
    if (!queue.items.length) throw new Error("injected queue save failure");
    originalSave(id, queue);
  });
  gate.resolve();
  await expect.poll(() => f.host.getSessionSnapshot(id).view.runs.at(-1)?.userMessage).toBe("once only");
  await expect.poll(() => f.host.activeRuns.size).toBe(0);
  expect(f.host.inputQueue.get(id).items).toHaveLength(0);
  failedSave.mockRestore();
  await f.host.submitInput({ sessionId: id, text: "later ordinary turn" });
  await expect.poll(() => f.host.activeRuns.size).toBe(0);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => restored.close());
  await restored.init();
  expect(restored.inputQueue.get(id).items).toHaveLength(0);
  await restored.inputQueue.resume(id);
  expect(
    restored.getSessionSnapshot(id).view.runs.filter((turn) => turn.userMessage === "once only"),
  ).toHaveLength(1);
});

it("closing an idle side chat stops its background work and blocks late notification revival", async () => {
  const f = await fixture();
  await run(f, "parent seed");
  const child = await f.host.createSideChat(f.session.id);
  await f.host.startRun({ sessionId: child.id, text: "side chat history" });
  await f.host.activeRuns.get(child.id)?.done;
  await f.host.backgroundTasks
    .tool(f.session.id, f.workspace)
    .execute(
      "parent-bg",
      { command: "sleep 30", run_in_background: true },
      undefined,
      undefined,
      undefined as never,
    );
  const tool = f.host.backgroundTasks.tool(child.id, f.workspace);
  await tool.execute(
    "bg",
    { command: "sleep 30", run_in_background: true },
    undefined,
    undefined,
    undefined as never,
  );
  const task = f.host.backgroundTasks.list(child.id)[0];
  await f.host.closeSideChat(child.id);
  expect(f.host.backgroundTasks.list(child.id)[0].status).toBe("cancelled");
  const notification = f.host as unknown as {
    deliverSubagentMessage(task: {
      parentSessionId: string;
      agentId: string;
      agentType: string;
      description: string;
      status: string;
      result: string;
    }): Promise<void>;
  };
  await expect(
    notification.deliverSubagentMessage({
      parentSessionId: child.id,
      agentId: task.taskId,
      agentType: "bash",
      description: "late result",
      status: "completed",
      result: "done",
    }),
  ).rejects.toThrow("已关闭");
  expect(f.host.activeRuns.has(child.id)).toBe(false);
  expect(f.host.backgroundTasks.list(f.session.id)[0].status).toBe("running");
  expect(f.host.getSessionSnapshot(child.id).view.runs[0].userMessage).toBe("side chat history");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs).toHaveLength(1);
  await f.host.closeSideChat(child.id);
  const reopened = await f.host.createSideChat(f.session.id);
  expect(reopened.id).not.toBe(child.id);
  await f.host.startRun({ sessionId: reopened.id, text: "new side chat" });
  await f.host.activeRuns.get(reopened.id)?.done;
  expect(f.host.getSessionSnapshot(reopened.id).view.runs.at(-1)?.status).toBe("completed");
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
  cleanup.push(() => restored.close());
  await restored.init();
  expect(restored.getSessionSnapshot(child.id).session.archivedAt).toEqual(expect.any(Number));
  expect(restored.getSessionSnapshot(child.id).view.runs[0].userMessage).toBe("side chat history");
  await expect(restored.startRun({ sessionId: child.id, text: "late wake" })).rejects.toThrow("已归档");
});

async function launchCompletedChild(f: Awaited<ReturnType<typeof fixture>>) {
  await run(f, "parent seed");
  const launch = f.host.subagents.tools(f.session.id).find((tool) => tool.name === "Agent");
  if (!launch) throw new Error("missing Agent tool");
  await launch.execute(
    "launch-child",
    { description: "Inspect source", prompt: "Remember original child instructions" },
    undefined,
    undefined,
    undefined as never,
  );
  return f.host.subagents.list(f.session.id)[0];
}

it.each([
  { restart: false, legacy: false, alreadyRestored: false },
  { restart: true, legacy: false, alreadyRestored: false },
  { restart: true, legacy: true, alreadyRestored: false },
  { restart: true, legacy: true, alreadyRestored: true },
])(
  "restores reusable agents without reopening closed side chats ($restart, $legacy, $alreadyRestored)",
  async ({ restart, legacy, alreadyRestored }) => {
    const f = await fixture();
    const task = await launchCompletedChild(f);
    const sideChat = await f.host.createSideChat(f.session.id);
    await f.host.closeSideChat(sideChat.id);
    await f.host.archiveSession(f.session.id);
    expect(f.host.getSessionSnapshot(task.childSessionId).session.archivedAt ?? null).toBeNull();
    if (alreadyRestored) f.host.restoreSession(f.session.id);
    // Reproduce the durable child state created by the 0.2.33–0.2.34 cascade.
    if (legacy) await f.host.archiveSession(task.childSessionId);
    let host = f.host;
    if (restart) {
      await f.host.close();
      host = new SessionHost(f.dir, f.settings, f.resources, f.workspace);
      cleanup.push(() => host.close());
      await host.init();
    }
    if (!alreadyRestored) {
      host.restoreSession(f.session.id);
      expect(host.getSessionSnapshot(task.childSessionId).session.archivedAt ?? null).toBeNull();
    } else {
      // An active parent has no Restore action in the UI; SendMessage must repair it lazily.
      expect(host.getSessionSnapshot(f.session.id).session.archivedAt).toBeNull();
      expect(host.getSessionSnapshot(task.childSessionId).session.archivedAt).toEqual(expect.any(Number));
    }
    expect(host.getSessionSnapshot(sideChat.id).session.archivedAt).toEqual(expect.any(Number));
    await expect(host.closeSideChat(task.childSessionId)).rejects.toThrow("不是辅助对话");
    host.subagents.prepare(f.session.id);
    const followup = host.subagents.tools(f.session.id).find((tool) => tool.name === "SendMessage");
    if (!followup) throw new Error("missing SendMessage tool");
    await followup.execute(
      "resume-child",
      { to: task.agentId, summary: "Continue", message: "Check the next file" },
      undefined,
      undefined,
      undefined as never,
    );
    await expect.poll(() => host.subagents.list(f.session.id)[0].status).toBe("completed");
    await expect.poll(() => host.activeRuns.size).toBe(0);
    expect(host.getSessionSnapshot(task.childSessionId).view.runs).toHaveLength(2);
    expect(host.getSessionSnapshot(task.childSessionId).session.archivedAt ?? null).toBeNull();
    const resumed = f.server.requests.find((request) =>
      JSON.stringify(request.messages).includes("Check the next file"),
    );
    expect(JSON.stringify(resumed?.messages)).toContain("Remember original child instructions");
    expect(host.getSessionSnapshot(sideChat.id).session.archivedAt).toEqual(expect.any(Number));
  },
);

it("archiving a parent drains a running reusable agent and its background commands", async () => {
  const childStarted = deferred();
  const f = await fixture((_, response, index) => {
    send(response, chunk({ content: "working" }));
    if (index === 0) done(response);
    else childStarted.resolve();
  });
  await run(f, "parent seed");
  const launch = f.host.subagents.tools(f.session.id).find((tool) => tool.name === "Agent");
  if (!launch) throw new Error("missing Agent tool");
  await launch.execute(
    "launch-child",
    { description: "Inspect source", prompt: "Keep working", run_in_background: true },
    undefined,
    undefined,
    undefined as never,
  );
  await childStarted.promise;
  const task = f.host.subagents.list(f.session.id)[0];
  await f.host.backgroundTasks
    .tool(task.childSessionId, f.workspace, true)
    .execute(
      "child-service",
      { command: "sleep 30", run_in_background: true },
      undefined,
      undefined,
      undefined as never,
    );
  await f.host.archiveSession(f.session.id);
  expect(f.host.activeRuns.size).toBe(0);
  expect(f.host.subagents.list(f.session.id)[0].status).toBe("aborted");
  expect(f.host.backgroundTasks.list(task.childSessionId)[0].status).toBe("cancelled");
  expect(f.host.getSessionSnapshot(task.childSessionId).session.archivedAt ?? null).toBeNull();
  expect(f.host.getSessionSnapshot(f.session.id).session.archivedAt).toEqual(expect.any(Number));
});

it("surfaces child restore persistence failures and permits retry after the parent was restored", async () => {
  const f = await fixture();
  const task = await launchCompletedChild(f);
  await f.host.archiveSession(f.session.id);
  await f.host.archiveSession(task.childSessionId);
  const owner = f.host as unknown as { indexes: Map<string, { append(): void }> };
  const child = owner.indexes.get(task.childSessionId);
  if (!child) throw new Error("missing child index");
  const failure = vi.spyOn(child, "append").mockImplementation(() => {
    throw new Error("storage: cannot restore child");
  });
  try {
    expect(() => f.host.restoreSession(f.session.id)).toThrow("cannot restore child");
    expect(f.host.getSessionSnapshot(f.session.id).session.archivedAt).toBeNull();
    expect(f.host.getSessionSnapshot(task.childSessionId).session.archivedAt).toEqual(expect.any(Number));
  } finally {
    failure.mockRestore();
  }
  f.host.restoreSession(f.session.id);
  expect(f.host.getSessionSnapshot(task.childSessionId).session.archivedAt ?? null).toBeNull();
});

it("side-chat closure rejects new runs and notifications while cleanup is still pending", async () => {
  const f = await fixture();
  await run(f, "parent seed");
  const child = await f.host.createSideChat(f.session.id);
  const entered = deferred(),
    release = deferred();
  const originalStop = f.host.backgroundTasks.stopAll.bind(f.host.backgroundTasks);
  vi.spyOn(f.host.backgroundTasks, "stopAll").mockImplementation(async (id) => {
    if (id === child.id) {
      entered.resolve();
      await release.promise;
    }
    await originalStop(id);
  });
  const closing = f.host.closeSideChat(child.id);
  await entered.promise;
  await expect(f.host.startRun({ sessionId: child.id, text: "late input" })).rejects.toThrow("关闭");
  const notification = f.host as unknown as {
    deliverSubagentMessage(task: {
      parentSessionId: string;
      agentId: string;
      agentType: string;
      description: string;
      status: string;
    }): Promise<void>;
  };
  await expect(
    notification.deliverSubagentMessage({
      parentSessionId: child.id,
      agentId: "agent_late",
      agentType: "general-purpose",
      description: "late",
      status: "completed",
    }),
  ).rejects.toThrow("已关闭");
  release.resolve();
  await closing;
  expect(f.host.getSessionSnapshot(f.session.id).session.archivedAt).toBeUndefined();
});

for (const fault of ["child-publication", "index-flush"] as const) {
  it(`cancellation releases run ownership and done despite ${fault} failure`, async () => {
    const started = deferred();
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "in progress" }));
      started.resolve();
    });
    const id = f.session.id;
    if (fault === "child-publication") {
      f.host.subagents.restore({
        agentId: "agent_fault",
        color: "blue",
        childSessionId: id,
        parentSessionId: id,
        parentToolCallId: "fault",
        agentType: "general-purpose",
        description: "fixture",
        background: false,
        status: "completed",
        startedAt: Date.now(),
        modelLabel: "fake",
        totalTokens: 0,
        totalToolUseCount: 0,
      });
    }
    await f.host.startRun({ sessionId: id, text: "hold" });
    await started.promise;
    await f.host.submitInput({ sessionId: id, text: "must stay queued" });
    const run = f.host.activeRuns.get(id);
    if (!run) throw new Error("missing active fixture run");
    const settleOwner = f.host as unknown as {
      settle(id: string, active: typeof run, error?: unknown): void;
      indexes: Map<string, { flush(): void }>;
    };
    const originalSettle = settleOwner.settle.bind(f.host);
    const observed = deferred();
    let settlementError: unknown;
    const settleSpy = vi.spyOn(settleOwner, "settle").mockImplementation((id, active, error) => {
      try {
        originalSettle(id, active, error);
      } catch (failure) {
        settlementError = failure;
      } finally {
        observed.resolve();
      }
    });
    const faultOwner =
      fault === "index-flush"
        ? (settleOwner.indexes.get(id) as { flush(): void })
        : (f.host.subagents as unknown as { port: { publish(task: { status: string }): void } }).port;
    const faultSpy =
      fault === "index-flush"
        ? vi.spyOn(faultOwner as { flush(): void }, "flush").mockImplementation(() => {
            throw new Error("storage: index fault");
          })
        : vi
            .spyOn(faultOwner as { publish(task: { status: string }): void }, "publish")
            .mockImplementation((task) => {
              if (task.status !== "running") throw new Error("storage: child publication fault");
            });
    let doneResolved = false;
    void run.done.then(() => {
      doneResolved = true;
    });
    const abort = f.host.abortRun({ sessionId: id, runId: run.runId });
    try {
      await observed.promise;
      await Promise.resolve();
      expect(settlementError).toBeUndefined();
      expect(f.host.activeRuns.has(id)).toBe(false);
      expect(doneResolved).toBe(true);
      expect(f.host.inputQueue.get(id).items.map((item) => item.text)).toEqual(["must stay queued"]);
      expect(f.server.requests).toHaveLength(1);
      expect(f.host.getSessionSnapshot(id).session.status).toBe("error");
    } finally {
      faultSpy.mockRestore();
      settleSpy.mockRestore();
      // The baseline intentionally fails before releasing this promise. Repair
      // only the isolated fixture so a regression failure cannot hang cleanup.
      if (f.host.activeRuns.get(id) === run) originalSettle(id, run);
      run.finish();
      await abort;
    }
    await f.host.close();
  });
}

it("shutdown surfaces subagent failure only after other live owners and resources drain", async () => {
  const started = deferred();
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "still running" }));
    started.resolve();
  });
  await f.host.startRun({ sessionId: f.session.id, text: "keep active" });
  await started.promise;
  await f.host.backgroundTasks
    .tool(f.session.id, f.workspace)
    .execute(
      "live-service",
      { command: "sleep 30", run_in_background: true },
      undefined,
      undefined,
      undefined as never,
    );
  const fault = new Error("subagent shutdown publication failed");
  const closeSubagents = vi.spyOn(f.host.subagents, "close").mockRejectedValue(fault);
  const queueClose = vi.spyOn(f.host.inputQueue, "close");
  const session = f.host.sessions.get(f.session.id);
  if (!session) throw new Error("missing fixture session");
  const disposed = vi.spyOn(session, "dispose");
  try {
    await expect(f.host.close()).rejects.toBe(fault);
    expect(f.host.backgroundTasks.list(f.session.id)[0].status).toBe("cancelled");
    expect(f.host.activeRuns.size).toBe(0);
    expect(queueClose).toHaveBeenCalledOnce();
    expect(disposed).toHaveBeenCalledOnce();
  } finally {
    closeSubagents.mockRestore();
    await f.host.close();
  }
});

it("shutdown reports all cleanup errors after attempting every history index", async () => {
  const f = await fixture();
  await run(f, "seed");
  const other = f.host.createSession(null);
  const owner = f.host as unknown as { indexes: Map<string, { flush(): void }> };
  const firstError = new Error("subagent cleanup failed");
  const firstIndexError = new Error("first index failed");
  const secondIndexError = new Error("second index failed");
  const subagentClose = vi.spyOn(f.host.subagents, "close").mockRejectedValue(firstError);
  const firstIndex = vi
    .spyOn(owner.indexes.get(f.session.id) as { flush(): void }, "flush")
    .mockImplementation(() => {
      throw firstIndexError;
    });
  const secondIndex = vi
    .spyOn(owner.indexes.get(other.id) as { flush(): void }, "flush")
    .mockImplementation(() => {
      throw secondIndexError;
    });
  try {
    await expect(f.host.close()).rejects.toMatchObject({
      errors: expect.arrayContaining([firstError, firstIndexError, secondIndexError]),
    });
    expect(firstIndex).toHaveBeenCalled();
    expect(secondIndex).toHaveBeenCalled();
    expect(f.host.activeRuns.size).toBe(0);
  } finally {
    subagentClose.mockRestore();
    firstIndex.mockRestore();
    secondIndex.mockRestore();
    await f.host.close();
  }
});
