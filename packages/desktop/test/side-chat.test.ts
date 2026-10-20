import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

for (const boundaryType of ["message", "run", "streaming-tools"] as const) {
  it(`inherits compacted context with a ${boundaryType} boundary without inheriting the timeline`, async () => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "retained answer" }));
      done(response);
    });
    const parent = f.host.createSession(f.a.id);
    await f.host.startRun({ sessionId: parent.id, text: "retained question" });
    await f.host.activeRuns.get(parent.id)?.done;
    await f.host.close();
    const path = join(f.dir, "agent", "sessions", f.a.id, `${parent.id}.jsonl`);
    const index = new HistoryIndex(path, f.settings.state.db);
    await index.load();
    const manager = SessionManager.fromStore(index);
    const boundary = [...manager.iterateEntries()].find((entry) =>
      boundaryType === "message"
        ? entry.type === "message" && entry.message.role === "user"
        : entry.type === "custom" && entry.customType === "zpi.run",
    );
    if (!boundary) throw new Error("Missing boundary fixture");
    // Streaming journals can also be the first kept entry in real desktop transcripts.
    if (boundaryType === "streaming-tools") {
      manager.replaceEntries(
        [...manager.iterateEntries()].map((entry) =>
          entry.id === boundary.id
            ? {
                ...entry,
                type: "custom",
                customType: "zpi.streaming_tools",
                data: { id: "fixture-journal", committed: true },
              }
            : entry,
        ),
      );
    }
    const firstKept =
      boundaryType === "streaming-tools"
        ? [...manager.iterateEntries()].find(
            (entry) => entry.type === "custom" && entry.customType === "zpi.streaming_tools",
          )
        : boundary;
    if (!firstKept) throw new Error("Missing kept entry");
    manager.appendCompaction("earlier decisions", firstKept.id);
    manager.appendCompaction("updated earlier decisions", firstKept.id);
    const expected = manager.buildSessionContext().messages;
    const persisted = f.settings.state.getTask(parent.id);
    if (!persisted) throw new Error("Missing task fixture");
    f.settings.state.upsertTask({ ...persisted, sessionFile: index.key });
    const original = await readFile(index.path, "utf8");
    const host = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
    await host.init();
    cleanup.push(() => host.close());
    const child = await host.createSideChat(parent.id);
    const childIndex = new HistoryIndex(host.sessionPath(child.id), f.settings.state.db);
    await childIndex.load();
    expect(SessionManager.fromStore(childIndex).buildSessionContext().messages.slice(0, -1)).toEqual(
      expected,
    );
    expect(host.getSessionSnapshot(child.id).view.runs).toHaveLength(0);
    expect(host.getHistoryPage(child.id, 0).view.runs).toHaveLength(0);
    await host.startRun({ sessionId: child.id, text: "explain decisions" });
    await host.activeRuns.get(child.id)?.done;
    expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("updated earlier decisions");
    expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("retained question");
    expect(host.getSessionSnapshot(child.id).view.runs.map((run) => run.userMessage)).toEqual([
      "explain decisions",
    ]);
    expect(await readFile(index.path, "utf8")).toBe(original);
  });
}

it("opens independent hidden chats with inherited context and an empty timeline, retaining isolation after restart", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "parent answer" }));
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "parent question" });
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.setSessionSelection(parent.id, { provider: "custom", modelId: "fake", reasoning: "high" });
  const path = join(f.dir, "agent", "sessions", f.a.id, `${parent.id}.jsonl`);
  const original = await readFile(path, "utf8");
  const child = await f.host.createSideChat(parent.id);
  const sibling = await f.host.createSideChat(parent.id);
  expect(child.id).not.toBe(sibling.id);
  expect(child.parentSessionId).toBe(parent.id);
  expect(f.host.getSessionSnapshot(child.id).view.controls?.selection?.reasoning).toBe("high");
  expect(f.host.getSessionSnapshot(parent.id).view.controls?.selection?.reasoning).toBe("high");
  expect(f.host.listRecentSessions().map((s) => s.id)).toEqual([parent.id]);
  expect(f.host.getSessionSnapshot(child.id).view.runs).toHaveLength(0);
  expect(f.host.getHistoryPage(child.id, 0).view.runs).toHaveLength(0);
  await f.host.startRun({ sessionId: child.id, text: "explain" });
  await f.host.activeRuns.get(child.id)?.done;
  const messages = JSON.stringify(f.server.requests.at(-1)?.messages);
  expect(messages).toContain("parent question");
  expect(messages).toContain("parent answer");
  expect(messages).toContain("Do not continue the parent's active work");
  expect(f.host.getSessionSnapshot(child.id).view.runs.map((r) => r.userMessage)).toEqual(["explain"]);
  expect(await readFile(path, "utf8")).toBe(original);
  await expect(
    f.host.forkSession(child.id, f.host.getSessionSnapshot(child.id).view.runs[0].runId),
  ).rejects.toThrow("不支持分叉");
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.listRecentSessions().map((s) => s.id)).toEqual([parent.id]);
  expect(restored.getSessionSnapshot(child.id).view.runs.map((r) => r.userMessage)).toEqual(["explain"]);
});

it.each(["idle", "running", "deleted historical provider"])(
  "inherits the parent's current model rather than its historical model (%s)",
  async (state) => {
    const started = deferred();
    const release = deferred();
    const f = await fixture(async (_, response, index) => {
      send(response, chunk({ content: "answer" }));
      if (state === "running" && index === 0) {
        started.resolve();
        await release.promise;
      }
      done(response);
    });
    const parent = f.host.createSession(f.a.id);
    await f.host.startRun({ sessionId: parent.id, text: "parent question" });
    if (state === "running") await started.promise;
    else await f.host.activeRuns.get(parent.id)?.done;
    f.settings.saveProvider({
      id: "next-provider",
      name: "Next provider",
      baseUrl: f.server.url,
      apiKey: "next-key",
      models: [{ id: "next-model", input: ["text"], reasoning: true, contextWindow: 32768, maxTokens: 4096 }],
    });
    const selection = { provider: "next-provider", modelId: "next-model", reasoning: "high" } as const;
    await f.host.setSessionSelection(parent.id, selection);
    // Another task's last-used model must not affect this child.
    f.settings.rememberSelection({ provider: "custom", modelId: "fake", reasoning: "none" });
    if (state === "deleted historical provider") f.settings.deleteProvider("custom");
    try {
      const child = await f.host.createSideChat(parent.id);
      expect(f.host.getSessionSnapshot(child.id).controls).toMatchObject({
        selection,
        selectionValid: true,
        lastThinkingLevel: "high",
      });
      await f.host.startRun({ sessionId: child.id, text: "child question" });
      await f.host.activeRuns.get(child.id)?.done;
      expect(f.server.requests.at(-1)?.model).toBe("next-model");
      if (state === "running") expect(f.host.sessions.get(parent.id)?.model.id).toBe("fake");
      release.resolve();
      await f.host.activeRuns.get(parent.id)?.done;
      await f.host.close();
      const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
      cleanup.push(() => restored.close());
      await restored.init();
      expect(restored.getSessionSnapshot(child.id).controls).toMatchObject({
        selection,
        selectionValid: true,
      });
    } finally {
      release.resolve();
    }
  },
);

it("copies the committed active user input without partial assistant output and stops only the closed side chat", async () => {
  const parentStarted = deferred();
  const parentRelease = deferred();
  const childStarted = deferred();
  const childRelease = deferred();
  const f = await fixture(async (_, response, index) => {
    if (index === 0) {
      send(response, chunk({ content: "partial parent" }));
      parentStarted.resolve();
      await parentRelease.promise;
    } else {
      send(response, chunk({ content: "partial child" }));
      childStarted.resolve();
      await childRelease.promise;
    }
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "active parent input" });
  await parentStarted.promise;
  const child = await f.host.createSideChat(parent.id);
  expect(f.settings.state.getTask(child.id)?.modelPerformanceTotals).toMatchObject({ turns: 0, steps: 0 });
  expect(f.host.getSessionSnapshot(child.id).historyCursor).toBeNull();
  await f.host.startRun({ sessionId: child.id, text: "child input" });
  await childStarted.promise;
  const messages = JSON.stringify(f.server.requests[1].messages);
  expect(messages).toContain("active parent input");
  expect(messages).not.toContain("partial parent");
  await f.host.closeSideChat(child.id);
  expect(f.host.activeRuns.has(child.id)).toBe(false);
  expect(f.host.activeRuns.has(parent.id)).toBe(true);
  parentRelease.resolve();
  childRelease.resolve();
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.deleteSession(parent.id);
  expect(() => f.host.getSessionSnapshot(child.id)).toThrow("不存在");
});

it("inherits 2/29 instead of seven internal prompts, rebuilds totals, and pages only local history", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "answer" }));
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "first" });
  await f.host.activeRuns.get(parent.id)?.done;
  const manager = f.host["manager"](parent.id);
  const assistant = [...manager.iterateEntries()].find(
    (entry) => entry.type === "message" && entry.message.role === "assistant",
  );
  if (assistant?.type !== "message" || assistant.message.role !== "assistant") throw new Error("fixture");
  manager.appendCustomEntry("zpi.run", { phase: "start", runId: "second", startedAt: Date.now() });
  for (let i = 0; i < 27; i++) {
    if (i % 5 === 0)
      manager.appendMessage({ role: "user", content: "internal prompt", timestamp: Date.now() });
    manager.appendMessage(assistant.message);
  }
  manager.appendCompaction("retained decisions", assistant.id, undefined, undefined, {
    input: 10,
    output: 2,
    cacheRead: 3,
    cacheWrite: 0,
    totalTokens: 15,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  });
  manager.appendCustomEntry("zpi.run", { phase: "end", runId: "second" });
  const child = await f.host.createSideChat(parent.id);
  const index = f.host["requiredIndex"](child.id);
  const reads = index.readBytes;
  const initial = f.host.getSessionSnapshot(child.id);
  expect(initial.view.modelPerformance).toMatchObject({ turns: 2, steps: 29 });
  expect(initial.view.runs).toEqual([]);
  expect(initial.historyCursor).toBeNull();
  expect(f.host.getHistoryPage(child.id, index.snapshot().endSeq + 1).cursor).toBeNull();
  expect(index.readBytes).toBe(reads);
  const saved = f.settings.state.getTask(child.id);
  if (!saved?.modelPerformanceTotals) throw new Error("Missing totals");
  f.settings.state.upsertTask({ ...saved, modelPerformanceTotals: undefined });
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ turns: 2, steps: 29 });
  await f.host.startRun({ sessionId: child.id, text: "local question" });
  await f.host.activeRuns.get(child.id)?.done;
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ turns: 3, steps: 30 });
  // Simulate an old installation's already-saved inflated totals, including local latency/usage.
  const completed = f.settings.state.getTask(child.id);
  if (!completed?.modelPerformanceTotals) throw new Error("Missing completed totals");
  const totals = { ...completed.modelPerformanceTotals, turns: 8, llmMs: 1234, toolMs: 567 };
  f.settings.state.upsertTask({
    ...completed,
    sideChatInheritance: undefined,
    modelPerformanceTotals: totals,
  });
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({
    turns: 3,
    steps: 30,
    llmMs: 1234,
    toolMs: 567,
  });
  const repaired = f.settings.state.getTask(child.id);
  if (!repaired) throw new Error("Missing repaired task");
  expect(repaired.modelPerformanceTotals).toEqual({ ...totals, turns: 3 });
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance?.turns).toBe(3);
  expect(f.settings.state.getTask(child.id)?.revision).toBe(repaired.revision);
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ turns: 3, steps: 30 });
  expect(restored.getSessionSnapshot(child.id).view.runs).toHaveLength(1);
  expect(restored.getSessionSnapshot(child.id).historyCursor).toBeNull();
  // A transcript generation rewrite must validate, rather than blindly trust, its old sequence boundary.
  const rewritten = restored["manager"](child.id);
  rewritten.replaceEntries([...rewritten.iterateEntries()]);
  expect(restored.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ turns: 3, steps: 30 });
  expect(f.settings.state.getTask(child.id)?.sideChatInheritance?.childGeneration).toBe(
    restored["requiredIndex"](child.id).snapshot().generation,
  );
});

it("keeps legacy usage and timings but omits unprovable inherited turns", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "answer" }));
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "original" });
  await f.host.activeRuns.get(parent.id)?.done;
  const child = await f.host.createSideChat(parent.id);
  const saved = f.settings.state.getTask(child.id);
  if (!saved?.modelPerformanceTotals) throw new Error("Missing totals");
  f.settings.state.upsertTask({ ...saved, sideChatInheritance: undefined });
  // IDs alone cannot verify a historical message if the parent's content was replaced.
  const manager = f.host["manager"](parent.id);
  manager.replaceEntries(
    [...manager.iterateEntries()].map((entry) =>
      entry.type === "message" && entry.message.role === "user"
        ? { ...entry, message: { ...entry.message, content: "changed" } }
        : entry,
    ),
  );
  const value = f.host.getSessionSnapshot(child.id).view.modelPerformance;
  expect(value?.turns).toBeUndefined();
  expect(value?.steps).toBe(1);
  expect(f.settings.state.getTask(child.id)?.modelPerformanceTotals).toEqual({
    ...saved.modelPerformanceTotals,
    turnsKnown: false,
  });
  await f.host.startRun({ sessionId: child.id, text: "local" });
  await f.host.activeRuns.get(child.id)?.done;
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ steps: 2 });
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance?.turns).toBeUndefined();
});

it("freezes an active parent's completed prefix rather than its later totals", async () => {
  const started = deferred();
  const release = deferred();
  const f = await fixture(async (_, response, i) => {
    send(response, chunk({ content: i ? "pending answer" : "completed answer" }));
    if (i === 1) {
      started.resolve();
      await release.promise;
    }
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "completed input" });
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.startRun({ sessionId: parent.id, text: "active input" });
  await started.promise;
  const child = await f.host.createSideChat(parent.id);
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ turns: 1, steps: 1 });
  const messages = f.host["manager"](child.id).buildSessionContext().messages;
  expect(JSON.stringify(messages)).toContain("active input");
  expect(JSON.stringify(messages)).not.toContain("pending answer");
  release.resolve();
  await f.host.activeRuns.get(parent.id)?.done;
  expect(f.host.getSessionSnapshot(parent.id).view.modelPerformance).toMatchObject({ turns: 2, steps: 2 });
  const saved = f.settings.state.getTask(child.id);
  if (!saved) throw new Error("Missing child");
  f.settings.state.upsertTask({ ...saved, modelPerformanceTotals: undefined });
  expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject({ turns: 1, steps: 1 });
});
