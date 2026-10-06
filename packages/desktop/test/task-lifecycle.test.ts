import { SessionManager } from "ZPI-coding-agent";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("running tasks reject archive/restore/delete while metadata rename and pin preserve the conversation", async () => {
  const f = await fixture((_, response) => send(response, chunk({ content: "still running" })));
  const id = f.host.createSession(f.a.id).id;
  const first = await f.host.startRun({ sessionId: id, text: "original input" });
  await expect.poll(() => f.host.getSessionSnapshot(id).view.runs[0].orderedBlocks.length).toBe(1);
  const before = f.host.getSessionSnapshot(id).view.runs;
  const file = join(f.dir, "agent", "sessions", f.a.id, `${id}.jsonl`);
  const context = SessionManager.open(file).buildSessionContext();
  f.host.renameSession(id, "手动任务名");
  f.host.setSessionPinned(id, true);
  expect(f.host.getSessionSnapshot(id).view.runs).toEqual(before);
  expect(SessionManager.open(file).buildSessionContext()).toEqual(context);
  await expect(f.host.archiveSession(id)).rejects.toThrow("请先停止运行");
  expect(() => f.host.restoreSession(id)).toThrow("请先停止运行");
  await expect(f.host.deleteSession(id)).rejects.toThrow("请先停止运行");
  expect(f.host.listRecentSessions()[0]).toMatchObject({ id, title: "手动任务名", status: "running" });
  await f.host.abortRun({ sessionId: id, runId: first.runId });
  expect(f.host.getSessionSnapshot(id).view.runs[0].status).toBe("aborted");
  expect(f.host.listRecentSessions()[0].title).toBe("手动任务名");
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listRecentSessions()[0]).toMatchObject({ title: "手动任务名", status: "aborted" });
});

it("archive discards pending messages, rejects later delivery and restores the original project after restart", async () => {
  const f = await fixture((body, response) => {
    send(response, chunk({ content: "reply" }));
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    if (user !== "hold") done(response);
  });
  const id = f.host.createSession(f.a.id).id;
  const run = await f.host.submitInput({ sessionId: id, text: "hold" });
  if (!("runId" in run) || !run.runId) throw new Error("missing run");
  await expect.poll(() => f.server.requests.length).toBe(1);
  await f.host.submitInput({ sessionId: id, text: "never delivered" });
  await f.host.abortRun({ sessionId: id, runId: run.runId });
  await f.host.archiveSession(id);
  expect(f.host.getSessionSnapshot(id).view.queue?.items).toEqual([]);
  expect(f.host.listRecentSessions()).toEqual([]);
  expect(f.host.listArchivedSessions()[0]).toMatchObject({
    id,
    projectId: f.a.id,
    projectName: "a",
    archivedAt: expect.any(Number),
  });
  await expect(f.host.submitInput({ sessionId: id, text: "late input" })).rejects.toThrow("已归档");
  await expect(f.host.startRun({ sessionId: id, text: "late direct run" })).rejects.toThrow("已归档");
  await expect(f.host.inputQueue.resume(id)).rejects.toThrow("已归档");
  f.host.removeProject(f.a.id);
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  reopened.restoreSession(id);
  expect(reopened.listSessions(f.a.id)[0].id).toBe(id);
  expect(reopened.listProjects().some((p) => p.id === f.a.id)).toBe(true);
  expect(reopened.getSessionSnapshot(id).view.queue?.items).toEqual([]);
  expect(f.server.requests).toHaveLength(1);
});

it("damaged tasks are listed for deletion, cannot restore, and deletion removes all task-owned storage", async () => {
  const f = await fixture((_, response) => done(response));
  const id = f.host.createSession(f.a.id).id;
  await f.host.close();
  const file = join(f.dir, "agent", "sessions", f.a.id, `${id}.jsonl`);
  const attachments = join(f.dir, "agent", "attachments", id);
  const snapshots = join(f.dir, "agent", "tool-output", id);
  await mkdir(attachments, { recursive: true });
  await mkdir(snapshots, { recursive: true });
  await writeFile(join(snapshots, "before.txt"), "snapshot");
  await writeFile(file, "broken header\n");
  const reopened = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  const record = reopened.listArchivedSessions().find((r) => r.id === id);
  expect(record?.diagnostic).toBeTruthy();
  expect(() => reopened.restoreSession(id)).toThrow("只能删除");
  reopened.saveDraft(id, { text: "draft", selection: [1, 1], fileReferences: [], revision: 1 });
  await writeFile(join(attachments, "orphan.png"), "image");
  await reopened.deleteSession(id);
  for (const path of [
    file,
    `${file}.index.json`,
    attachments,
    snapshots,
    join(f.dir, "drafts", `${id}.json`),
  ])
    await expect(access(path)).rejects.toThrow();
  expect(reopened.listArchivedSessions()).toEqual([]);
  expect(await readFile(join(f.dir, "projects.json"), "utf8")).toContain(f.a.path);
});
