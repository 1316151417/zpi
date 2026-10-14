import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("keeps cross-project membership through pin/archive/restore and restart, then atomically ungroups without deleting tasks", async () => {
  const { host, dir, settings, a, b } = await fixture((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const first = host.createSession(a.id),
    second = host.createSession(b.id),
    third = host.createSession(a.id);
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
  const { host, dir, a } = await fixture((_, response) => {
    send(response, chunk({ content: "forkable answer" }));
    done(response);
  });
  const first = host.createSession(a.id),
    second = host.createSession(a.id);
  host.updateTaskGroups({ type: "taskTop", id: first.id });
  const third = host.createSession(a.id);
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
  const saved = JSON.parse(await readFile(join(dir, "task-groups.json"), "utf8"));
  expect(saved.members[group.id]).toEqual([]);
  expect(JSON.stringify(saved)).not.toContain(second.id);
});
it("rolls back a newly created session and its index when the group file cannot be committed", async () => {
  const { mkdir, readdir } = await import("node:fs/promises");
  const { host, dir, a } = await fixture((_, response) => {
    done(response);
  });
  // A directory at the destination deterministically makes the atomic rename fail, without OS permission assumptions.
  await mkdir(join(dir, "task-groups.json"));
  expect(() => host.createSession(a.id)).toThrow();
  expect(host.listRecentSessions()).toEqual([]);
  expect(host.getTaskGroups().roots).toEqual([]);
  expect(await readdir(join(dir, "agent", "sessions", a.id))).toEqual([]);
});
it("creates a draft inside its chosen group in one operation, and rejects a stale group without leaving a session", async () => {
  const { host, a } = await fixture((_, response) => {
    done(response);
  });
  const group = host.updateTaskGroups({ type: "create" }).groups[0];
  const draft = host.createSession(a.id, { groupId: group.id });
  expect(host.getTaskGroups().members[group.id]).toEqual([draft.id]);
  expect(() => host.createSession(a.id, { groupId: "deleted-group" })).toThrow("not_found");
  expect(host.listRecentSessions().map((record) => record.id)).toEqual([draft.id]);
});
