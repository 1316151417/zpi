import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { done } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("reconciles durable accepted input after a database failure without executing it on restart", async () => {
  const f = await fixture((_, response) => done(response));
  const task = f.host.createSession(f.a.id);
  const complete = f.settings.state.completeIntent.bind(f.settings.state);
  const failure = vi.spyOn(f.settings.state, "completeIntent").mockImplementation((id, finalize) => {
    if (
      f.settings.state
        .listIntents()
        .some((intent) => intent.operationId === id && intent.kind === "accept-input")
    )
      throw new Error("accept commit failed");
    complete(id, finalize);
  });
  await expect(f.host.startRun({ sessionId: task.id, text: "retain this input" })).rejects.toThrow(
    "accept commit failed",
  );
  expect(f.server.requests).toHaveLength(0);
  expect(f.settings.state.listIntents()).toHaveLength(1);
  failure.mockRestore();
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(f.settings.state.listIntents()).toEqual([]);
  expect(f.settings.state.getTask(task.id)).toMatchObject({ draft: false, status: "interrupted" });
  expect(reopened.getSessionSnapshot(task.id).view.runs).toHaveLength(1);
  expect(reopened.getSessionSnapshot(task.id).view.runs[0].userMessage).toBe("retain this input");
  expect(f.server.requests).toHaveLength(0);
});

it("retains incomplete acceptance and blocks resubmission rather than running it again", async () => {
  const f = await fixture((_, response) => done(response));
  const task = f.host.createSession(f.a.id);
  const owner = f.host as unknown as {
    indexes: Map<
      string,
      { append(entry: { type: string; customType?: string; data?: { phase?: string } }): void }
    >;
  };
  const index = owner.indexes.get(task.id);
  if (!index) throw new Error("Missing index fixture");
  const append = index.append.bind(index);
  const failure = vi.spyOn(index, "append").mockImplementation((entry) => {
    if (entry.customType === "zpi.run" && entry.data?.phase === "accepted")
      throw new Error("accept marker failed");
    append(entry);
  });
  await expect(f.host.startRun({ sessionId: task.id, text: "uncertain input" })).rejects.toThrow(
    "accept marker failed",
  );
  failure.mockRestore();
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(f.settings.state.listIntents()[0].stage).toBe("blocked");
  await expect(reopened.startRun({ sessionId: task.id, text: "retry" })).rejects.toThrow("storage:");
  expect(f.server.requests).toHaveLength(0);
});

it("shares successful shutdown and never flushes a retired host again", async () => {
  const f = await fixture((_, response) => done(response));
  const task = f.host.createSession(f.a.id);
  const owner = f.host as unknown as { indexes: Map<string, { flush(): void }> };
  const index = owner.indexes.get(task.id);
  if (!index) throw new Error("Missing index fixture");
  const flush = vi.spyOn(index, "flush");
  const first = f.host.close();
  expect(f.host.close()).toBe(first);
  await first;
  await f.host.close();
  expect(flush).toHaveBeenCalledOnce();
});

it("does not resurrect an accepted queue item when a stale queue snapshot is saved", async () => {
  const f = await fixture((_, response) => done(response));
  const task = f.host.createSession(f.a.id);
  const queue = {
    autoDrain: true,
    items: [
      {
        id: "queued",
        state: "queued" as const,
        text: "send once",
        attachments: [],
        fileReferences: [],
        selection: { provider: "custom", modelId: "fake", reasoning: "none" as const },
      },
    ],
  };
  f.settings.state.setQueue(task.id, queue);
  const intent = {
    operationId: "accept",
    taskId: task.id,
    kind: "accept-input" as const,
    stage: "prepared" as const,
    targetFile: "task.jsonl",
    queueItemId: "queued",
    runId: "run",
  };
  f.settings.state.reserveQueuedInput(intent);
  f.settings.state.putIntent({ ...intent, stage: "durable", watermark: 42 });
  f.settings.state.completeQueuedInput("accept");
  f.settings.state.setQueue(task.id, queue);
  expect(f.settings.state.getQueue(task.id)?.items).toEqual([]);
  await f.host.deleteSession(task.id);
  expect(f.settings.state.acceptedInputIds(task.id).size).toBe(0);
  expect(f.settings.state.listIntents()).toEqual([]);
});

it("keeps a committed task deletion deleted when attachment cleanup fails", async () => {
  const f = await fixture((_, response) => done(response));
  const task = f.host.createSession(f.a.id);
  vi.spyOn(f.host.attachments, "deleteSession").mockRejectedValue(new Error("cleanup failed"));
  await expect(f.host.deleteSession(task.id)).resolves.toBeUndefined();
  expect(f.settings.state.getTask(task.id)).toBeUndefined();
  expect(f.host.listSessions(f.a.id).some((entry) => entry.id === task.id)).toBe(false);
  expect(() => f.host.renameSession(task.id, "resurrected")).toThrow();
  expect(f.settings.state.getTask(task.id)).toBeUndefined();
  expect(await readFile(join(f.dir, "agent", "logs", "error.log"), "utf8")).toContain(
    '"source":"session.delete.cleanup"',
  );
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listSessions(f.a.id)).toEqual([]);
});

it("retains the in-memory task when committing its deletion fails", async () => {
  const f = await fixture((_, response) => done(response));
  const task = f.host.createSession(f.a.id);
  const before = f.settings.state.getTask(task.id);
  const attachments = vi.spyOn(f.host.attachments, "deleteSession");
  vi.spyOn(f.settings.state, "deleteTask").mockImplementation(() => {
    throw new Error("delete commit failed");
  });
  await expect(f.host.deleteSession(task.id)).rejects.toThrow("delete commit failed");
  expect(f.settings.state.getTask(task.id)).toEqual(before);
  expect(f.host.listSessions(f.a.id).some((entry) => entry.id === task.id)).toBe(true);
  expect(attachments).not.toHaveBeenCalled();
});

for (const phase of ["prepared", "durable", "published"] as const) {
  it(`reopens the authoritative generation after a ${phase} replacement failure`, async () => {
    const f = await fixture((_, response) => done(response));
    const task = f.host.createSession(f.a.id);
    const { HistoryIndex } = await import("../src/main/history-index.ts");
    const owner = f.host as unknown as { indexes: Map<string, InstanceType<typeof HistoryIndex>> };
    const index = owner.indexes.get(task.id);
    if (!index) throw new Error("Missing index fixture");
    const oldPath = index.path;
    const original = await readFile(oldPath);
    const originalCount = index.snapshot().endSeq;
    let fault: ReturnType<typeof vi.spyOn> | undefined;
    if (phase === "prepared") {
      f.settings.state.db.exec(`CREATE TRIGGER fail_replacement AFTER INSERT ON transcript_entries
        WHEN NEW.entry_id='replacement-2' BEGIN SELECT RAISE(ABORT, 'injected prepared failure'); END`);
    } else {
      const complete = f.settings.state.completeIntent.bind(f.settings.state);
      fault = vi.spyOn(f.settings.state, "completeIntent").mockImplementation((id, finalize) => {
        const replace = f.settings.state
          .listIntents()
          .some((intent) => intent.operationId === id && intent.kind === "replace");
        if (replace && phase === "durable") throw new Error("injected durable failure");
        complete(id, finalize);
        if (replace) throw new Error("injected published failure");
      });
    }
    const entries = [1, 2].map((n) => ({
      type: "message" as const,
      id: `replacement-${n}`,
      parentId: n === 1 ? null : "replacement-1",
      timestamp: new Date(1).toISOString(),
      message: { role: "user" as const, content: `replacement ${n}`, timestamp: n },
    }));
    expect(() => index.replace(index.getHeader(), entries)).toThrow(`injected ${phase} failure`);
    fault?.mockRestore();
    f.settings.state.db.exec("DROP TRIGGER IF EXISTS fail_replacement");
    expect(await readFile(oldPath)).toEqual(original);
    expect(index.path).toBe(oldPath);
    const intents = f.settings.state.listIntents();
    if (phase === "published") expect(intents).toEqual([]);
    else expect(intents).toHaveLength(1);
    if (phase !== "published") expect(intents[0].stage).toBe(phase);
    await f.host.close();
    const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
    await reopened.init();
    cleanup.push(() => reopened.close());
    const restored = new HistoryIndex(reopened.sessionPath(task.id), f.settings.state.db);
    await restored.load();
    expect(restored.snapshot().endSeq).toBe(phase === "published" ? 2 : originalCount);
    if (phase === "published") {
      expect(restored.path).not.toBe(oldPath);
      expect(restored.getTail(restored.snapshot())?.entry).toMatchObject({ id: "replacement-2" });
      expect(f.settings.state.listIntents()).toEqual([]);
    } else {
      expect(restored.path).toBe(oldPath);
      expect(f.settings.state.listIntents()[0].stage).toBe("blocked");
      await expect(reopened.startRun({ sessionId: task.id, text: "do not execute" })).rejects.toThrow(
        "storage:",
      );
    }
    expect(f.server.requests).toHaveLength(0);
  });
}
