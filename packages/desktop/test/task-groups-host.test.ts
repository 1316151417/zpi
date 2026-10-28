import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("keeps cross-project membership through pin/archive/restore and restart, then atomically ungroups without deleting tasks", async () => {
  const { host, dir, settings, a, b } = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const first = await host.createSession(a.id),
    second = await host.createSession(b.id),
    third = await host.createSession(a.id);
  const group = host.updateTaskGroups({ type: "create" }).groups[0];
  for (const record of [first, second])
    host.updateTaskGroups({ type: "moveTask", id: record.id, groupId: group.id });
  host.setSessionPinned(first.id, true);
  await host.archiveSession(second.id);
  host.updateTaskGroups({ type: "taskTop", id: third.id });
  expect(host.getTaskGroups().members[group.id]).toEqual([first.id, second.id]);
  host.setSessionPinned(first.id, false);
  host.restoreSession(second.id);
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "agent"));
  cleanup.push(() => reopened.close());
  await reopened.init();
  expect(reopened.getTaskGroups().members[group.id]).toEqual([first.id, second.id]);
  reopened.updateTaskGroups({ type: "delete", id: group.id });
  expect(
    reopened
      .listRecentSessions()
      .map((record) => record.id)
      .sort(),
  ).toEqual([first.id, second.id, third.id].sort());
  expect(reopened.getTaskGroups().roots.map((node) => node.id)).toEqual([third.id, first.id, second.id]);
  for (const record of [first, second])
    expect(await readFile(reopened.sessionPath(record.id), "utf8")).toContain(record.id);
});
it("puts newly created and forked public tasks at root top without moving existing nodes; child sessions never enter groups", async () => {
  const { host, settings, a } = await fixture((_, response) => {
    send(response, chunk({ content: "forkable answer" }));
    done(response);
  });
  const first = await host.createSession(a.id),
    second = await host.createSession(a.id);
  host.updateTaskGroups({ type: "taskTop", id: first.id });
  const third = await host.createSession(a.id);
  expect(host.getTaskGroups().roots.map((node) => node.id)).toEqual([third.id, first.id, second.id]);
  const complete = new Promise<void>((resolve) => {
    const off = host.subscribe((event) => {
      if (event.sessionId === first.id && event.event.type === "settled") {
        off();
        resolve();
      }
    });
  });
  const run = await host.startRun({ sessionId: first.id, text: "reply" });
  await complete;
  const fork = await host.forkSession(first.id, run.runId);
  expect(host.getTaskGroups().roots.map((node) => node.id)).toEqual([fork.id, third.id, first.id, second.id]);
  const child = await host.createSideChat(first.id);
  expect(host.getTaskGroups().roots.some((node) => node.id === child.id)).toBe(false);
  const group = host.updateTaskGroups({ type: "create" }).groups[0];
  host.updateTaskGroups({ type: "moveTask", id: second.id, groupId: group.id });
  await host.deleteSession(second.id);
  const saved = settings.state.getTaskGroups();
  if (!saved) throw new Error("Missing groups fixture");
  expect(saved.members[group.id]).toEqual([]);
  expect(JSON.stringify(saved)).not.toContain(second.id);
});
it("rolls back task publication when group commit fails and preserves the recovery intent", async () => {
  const { host, settings, a } = await fixture((_, response) => done(response));
  const failure = vi.spyOn(settings.state, "setTaskGroups").mockImplementation(() => {
    throw new Error("group commit failed");
  });
  await expect(host.createSession(a.id)).rejects.toThrow("group commit failed");
  failure.mockRestore();
  expect(host.listRecentSessions()).toEqual([]);
  expect(settings.state.listTasks()).toEqual([]);
  expect(host.getTaskGroups().roots).toEqual([]);
  expect(settings.state.listIntents()).toHaveLength(1);
});
it("creates a draft inside its chosen group in one operation, and rejects a stale group without leaving a session", async () => {
  const { host, a } = await fixture((_, response) => {
    done(response);
  });
  const group = host.updateTaskGroups({ type: "create" }).groups[0];
  const draft = await host.createSession(a.id, { groupId: group.id });
  expect(host.getTaskGroups().members[group.id]).toEqual([draft.id]);
  await expect(host.createSession(a.id, { groupId: "deleted-group" })).rejects.toThrow("not_found");
  expect(host.listRecentSessions().map((record) => record.id)).toEqual([draft.id]);
});

it("rejects stale drag sources and removed anchors without overwriting newer organization", async () => {
  const { host, settings, a } = await fixture((_, response) => done(response));
  const first = await host.createSession(a.id),
    second = await host.createSession(a.id);
  const group = host.updateTaskGroups({ type: "create" }).groups[0];
  host.updateTaskGroups({ type: "moveTask", id: first.id, groupId: group.id });
  const before = host.getTaskGroups();
  expect(() =>
    host.updateTaskGroups({ type: "moveTask", id: first.id, sourceGroupId: null, groupId: null }),
  ).toThrow("任务分组已变化");
  expect(() =>
    host.updateTaskGroups({
      type: "moveTask",
      id: second.id,
      sourceGroupId: null,
      groupId: null,
      before: { type: "task", id: "gone" },
    }),
  ).toThrow("拖动目标已变化");
  expect(() =>
    host.updateTaskGroups({
      type: "moveTask",
      id: second.id,
      sourceGroupId: null,
      groupId: null,
      before: { type: "task", id: first.id },
    }),
  ).toThrow("拖动目标已变化");
  expect(host.getTaskGroups()).toEqual(before);
  expect(settings.state.getTaskGroups()).toEqual(before);
  host.updateTaskGroups({
    type: "moveTask",
    id: second.id,
    sourceGroupId: null,
    groupId: group.id,
    before: { type: "task", id: first.id },
  });
  expect(host.getTaskGroups().members[group.id]).toEqual([second.id, first.id]);
});

it("rejects a drag when its task or anchor was archived after the gesture started", async () => {
  const { host, a } = await fixture((_, response) => done(response));
  const first = await host.createSession(a.id),
    second = await host.createSession(a.id);
  await host.archiveSession(first.id);
  const before = host.getTaskGroups();
  expect(() =>
    host.updateTaskGroups({
      type: "moveTask",
      id: first.id,
      sourceGroupId: null,
      groupId: null,
      start: true,
    }),
  ).toThrow("任务不存在");
  expect(() =>
    host.updateTaskGroups({
      type: "moveTask",
      id: second.id,
      sourceGroupId: null,
      groupId: null,
      before: { type: "task", id: first.id },
    }),
  ).toThrow("拖动目标已变化");
  expect(host.getTaskGroups()).toEqual(before);
});
