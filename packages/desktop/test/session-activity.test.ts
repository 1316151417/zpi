import { SessionManager } from "ZPI-coding-agent";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
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
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
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
  const events: import("ZPI-ui").DesktopEventEnvelope[] = [];
  f.host.subscribe((e) => events.push(e));
  await f.host.startRun({ sessionId: id, text: "hello" });
  await vi.waitFor(() => expect(events.some((e) => e.event.type === "block_delta")).toBe(true));
  const delta = events.find((e) => e.event.type === "block_delta");
  expect(delta?.activityAt).toBeGreaterThan(0);
  expect(f.host.listRecentSessions()[0]).toMatchObject({ running: true });
  const updatedAt = f.host.listRecentSessions()[0].updatedAt;
  f.host.renameSession(id, "metadata");
  expect(events.at(-1)?.activityAt).toBeUndefined();
  expect(f.host.listRecentSessions()[0].updatedAt).toBe(updatedAt);
  await f.host.close();
});

it("reconstructs last message activity for an interrupted historical run", async () => {
  const f = await fixture((_, response) => done(response));
  await f.host.close();
  const root = join(f.dir, "agent", "sessions", f.a.id);
  await mkdir(root, { recursive: true });
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-01T01:00:00Z"));
    const manager = SessionManager.create(f.a.path, root);
    manager.appendCustomEntry("ZPI.session_meta", { projectId: f.a.id, pinnedAt: null });
    manager.appendCustomEntry("ZPI.run", { runId: "r", phase: "start", startedAt: Date.now(), text: "hi" });
    vi.setSystemTime(new Date("2026-10-01T02:00:00Z"));
    manager.appendMessage({ role: "user", content: "hi", timestamp: Date.now() });
    const activity = Date.now();
    vi.setSystemTime(new Date("2026-10-08T00:00:00Z"));
    manager.appendSessionInfo("later metadata");
    const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
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
