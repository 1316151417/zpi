import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { sessionActivityAt, streamingActivityIntervalMs } from "../src/main/session-activity.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("uses the header creation time and persisted conversation activity, excluding metadata", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "done" }));
    done(response);
  });
  const created = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: created.id, text: "hello" });
  await f.host.activeRuns.get(created.id)?.done;
  const completed = f.host.getSessionSnapshot(created.id).session;
  expect(completed.createdAt).toBe(created.createdAt);
  expect(completed.updatedAt).toBeGreaterThanOrEqual(created.createdAt);
  expect(completed.running).toBe(false);
  f.host.renameSession(created.id, "renamed");
  f.host.setSessionPinned(created.id, true);
  f.host.activateSession(created.id);
  expect(f.host.listRecentSessions()[0].updatedAt).toBe(completed.updatedAt);
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.getSessionSnapshot(created.id).session).toMatchObject({
    createdAt: created.createdAt,
    updatedAt: completed.updatedAt,
    running: false,
  });
});

it("stamps streaming activity at the Host and does not promote metadata or stale status to running", async () => {
  const f = await fixture((_, response) => send(response, chunk({ content: "partial" })));
  const id = f.host.createSession(f.a.id).id;
  const events: import("zpi-ui").DesktopEventEnvelope[] = [];
  f.host.subscribe((e) => events.push(e));
  await f.host.startRun({ sessionId: id, text: "hello" });
  await vi.waitFor(() => expect(events.some((e) => e.event.type === "block_delta")).toBe(true));
  const delta = events.find((e) => e.event.type === "block_delta");
  expect(delta?.activityAt).toBeUndefined();
  expect(events.find((e) => e.event.type === "started")?.activityAt).toBeGreaterThan(0);
  expect(f.host.listRecentSessions()[0]).toMatchObject({ running: true });
  const updatedAt = f.host.listRecentSessions()[0].updatedAt;
  f.host.renameSession(id, "metadata");
  expect(events.at(-1)?.activityAt).toBeUndefined();
  expect(f.host.listRecentSessions()[0].updatedAt).toBe(updatedAt);
  await f.host.close();
});

it("samples streaming task activity while preserving lifecycle timestamps and clock changes", () => {
  const delta = { type: "block_delta", messageId: "message", contentIndex: 0, delta: "private" } as const;
  const previous = 20_000;
  expect(sessionActivityAt(delta, previous, previous + streamingActivityIntervalMs - 1)).toBeUndefined();
  expect(sessionActivityAt(delta, previous, previous + streamingActivityIntervalMs)).toBe(25_000);
  expect(sessionActivityAt(delta, previous, previous - 1)).toBe(previous - 1);
  expect(
    sessionActivityAt({ type: "tool_update", toolCallId: "t", output: "private" }, previous, 20_001),
  ).toBeUndefined();
  expect(sessionActivityAt({ type: "tool_end", toolCallId: "t", output: "private" }, previous, 20_001)).toBe(
    20_001,
  );
  expect(
    sessionActivityAt({ type: "started", text: "hi", startedAt: 123, modelLabel: "m" }, previous, 50_000),
  ).toBe(123);
  expect(sessionActivityAt({ type: "settled", status: "error", endedAt: 456 }, previous, 50_000)).toBe(456);
  expect(sessionActivityAt({ type: "question_changed", question: null }, previous, 50_000)).toBeUndefined();
});

it("delivers every streamed delta without stamping task activity for each token", async () => {
  const f = await fixture((_, response) => {
    for (let i = 0; i < 100; i++) send(response, chunk({ content: "x" }));
    done(response);
  });
  const id = f.host.createSession(f.a.id).id;
  const events: import("zpi-ui").DesktopEventEnvelope[] = [];
  f.host.subscribe((event) => events.push(event));
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
  try {
    await f.host.startRun({ sessionId: id, text: "hello" });
    await f.host.activeRuns.get(id)?.done;
    const deltas = events.filter((event) => event.event.type === "block_delta");
    expect(deltas).toHaveLength(100);
    expect(deltas.every((event) => event.activityAt === undefined)).toBe(true);
    expect(f.host.getSessionSnapshot(id).view.runs.at(-1)?.orderedBlocks.at(-1)).toMatchObject({
      text: "x".repeat(100),
    });
    expect(events.find((event) => event.event.type === "settled")?.activityAt).toBeGreaterThan(0);
  } finally {
    clock.mockRestore();
  }
});

it("reconstructs last message activity for an interrupted historical run", async () => {
  const f = await fixture((_, response) => done(response));
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));
    const task = f.host.createSession(f.a.id);
    const index = new HistoryIndex(f.host.sessionPath(task.id), f.settings.state.db);
    await index.load();
    const manager = SessionManager.fromStore(index);
    manager.appendCustomEntry("zpi.run", { runId: "r", phase: "start", startedAt: Date.now(), text: "hi" });
    vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    const activity = Date.now();
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    const persisted = f.settings.state.getTask(task.id);
    if (!persisted) throw new Error("Missing task fixture");
    f.settings.state.upsertTask({
      ...persisted,
      title: "later metadata",
      draft: false,
      status: "running",
      updatedAt: activity,
    });
    await f.host.close();
    const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined);
    await reopened.init();
    cleanup.push(() => reopened.close());
    expect(reopened.listRecentSessions().find((s) => s.id === manager.getSessionId())).toMatchObject({
      createdAt: Date.parse("2026-10-01T01:00:00Z"),
      updatedAt: activity,
      status: "interrupted",
      running: false,
    });
  } finally {
    vi.useRealTimers();
  }
});
