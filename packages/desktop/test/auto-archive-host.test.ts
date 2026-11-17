import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { piTemplate } from "@zpi-dev/coding-agent";
import { afterEach, expect, it, vi } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import type { TextDraft } from "../src/main/draft-store.ts";
import { SessionHost } from "../src/main/session-host.ts";
import type { TaskState } from "../src/main/state-store.ts";
import * as worktrees from "../src/main/worktrees.ts";
import { createWorktree } from "../src/main/worktrees.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

const exec = promisify(execFile);
const day = 86400000;
type Fixture = Awaited<ReturnType<typeof fixture>>;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}

function seed(f: Fixture, id: string, patch: Partial<TaskState> = {}) {
  const task = f.settings.state.getTask(id);
  if (!task) throw new Error("missing task fixture");
  f.settings.state.upsertTask({
    ...task,
    draft: false,
    frozenConfiguration: task.frozenConfiguration ?? {
      template: piTemplate,
      pluginsVersion: 3,
      plugins: [],
    },
    updatedAt: Date.now() - 40 * day,
    ...patch,
  });
}

async function reopen(f: Fixture) {
  await f.host.close();
  const host = new SessionHost(
    f.dir,
    f.settings,
    join(f.dir, "agent"),
    undefined,
    undefined,
    undefined,
    join(f.dir, "trees"),
  );
  cleanup.push(() => host.close());
  await host.init();
  return host;
}

async function treeFixture() {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "retained answer" }));
    done(response);
  });
  await git(f.a.path, "init", "-b", "main");
  await git(f.a.path, "config", "user.email", "test@example.test");
  await git(f.a.path, "config", "user.name", "Test");
  await writeFile(join(f.a.path, "tracked.txt"), "committed content");
  await git(f.a.path, "add", ".");
  await git(f.a.path, "commit", "-m", "Initial");
  const tree = await createWorktree(f.a.path, join(f.dir, "trees"));
  const task = await f.host.createSession(f.a.id, { cwd: tree.path });
  await f.host.startRun({ sessionId: task.id, text: "keep this history" });
  await f.host.activeRuns.get(task.id)?.done;
  await f.host.close();
  seed(f, task.id, { newWorktree: true, worktree: tree, unreadAt: undefined });
  return { ...f, task, tree };
}

it("keeps background archiving off by default while allowing an explicit scan", async () => {
  const f = await fixture((_, response) => done(response));
  const task = await f.host.createSession(f.a.id);
  await f.host.close();
  seed(f, task.id);
  const host = await reopen(f);
  expect(await host.runAutoArchive()).toEqual({ archived: 0, skipped: 0, details: [] });
  expect(f.settings.state.getTask(task.id)?.archivedAt).toBeUndefined();
  expect(await host.runAutoArchive(true)).toEqual({ archived: 1, skipped: 0, details: [] });
  expect(f.settings.state.getTask(task.id)?.archivedAt).toEqual(expect.any(Number));
  expect(f.server.requests).toHaveLength(0);
});

it("archives only expired idle tasks and protects the cutoff, pins, unread work, drafts, queues, and open task", async () => {
  const f = await fixture((_, response) => done(response));
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  f.settings.updateAutoArchive({ enabled: true, olderThanDays: 7 });
  const ids: Record<string, string> = {};
  for (const name of ["old", "cutoff", "pinned", "unread", "draft", "text", "queued", "open"])
    ids[name] = (await f.host.createSession(f.a.id)).id;
  await f.host.close();
  for (const id of Object.values(ids)) seed(f, id);
  seed(f, ids.cutoff, { updatedAt: now - 7 * day });
  seed(f, ids.pinned, { pinnedAt: now });
  seed(f, ids.unread, { unreadAt: now });
  seed(f, ids.draft, { draft: true });
  const draft: TextDraft = {
    text: "unfinished input",
    fileReferences: [],
    selection: [0, 0],
    revision: 1,
  };
  f.settings.state.saveDraft(ids.text, draft);
  f.settings.state.setQueue(ids.queued, {
    items: [
      {
        id: "queued-input",
        state: "queued",
        text: "keep pending input",
        attachments: [],
        fileReferences: [],
        selection: { provider: "custom", modelId: "fake", reasoning: "none" },
      },
    ],
    autoDrain: false,
  });
  const host = await reopen(f);
  host.activateSession(ids.open);
  expect(await host.runAutoArchive()).toMatchObject({ archived: 1, skipped: 0 });
  expect(host.listArchivedSessions().map((task) => task.id)).toEqual([ids.old]);
  for (const [name, id] of Object.entries(ids))
    if (name !== "old") expect(f.settings.state.getTask(id)?.archivedAt).toBeUndefined();
  expect(host.inputQueue.get(ids.queued).items[0]?.text).toBe("keep pending input");
  expect(host.drafts.get(ids.text).text).toBe("unfinished input");
  expect(f.server.requests).toHaveLength(0);
});

it("removes an archived task's worktree and restores its original checkout and conversation", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  const head = await git(f.tree.path, "rev-parse", "HEAD");
  const before = host.getSessionSnapshot(f.task.id);
  const changed = vi.fn();
  host.onTasksChanged(changed);
  expect(await host.runAutoArchive(true)).toEqual({ archived: 1, skipped: 0, details: [] });
  expect(existsSync(f.tree.path)).toBe(false);
  expect(await git(f.a.path, "worktree", "list", "--porcelain")).not.toContain(f.tree.path);
  expect(f.settings.state.getTask(f.task.id)).toMatchObject({
    cwd: f.tree.path,
    archivedWorktreeHead: head,
    archivedAt: expect.any(Number),
  });
  await host.restoreSession(f.task.id);
  expect(host.workspaceInfo(f.task.id).cwd).toBe(f.tree.path);
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("committed content");
  expect(host.getSessionSnapshot(f.task.id).view.runs).toEqual(before.view.runs);
  expect(host.getSessionSnapshot(f.task.id).session.archivedAt).toBeNull();
  expect(changed).toHaveBeenCalledTimes(2);
  expect(f.server.requests).toHaveLength(1);
});

it("restores a named worktree branch after archiving and restarting", async () => {
  const f = await treeFixture();
  await git(f.tree.path, "switch", "-c", "feature/archived-task");
  const host = await reopen(f);
  expect(await host.runAutoArchive(true)).toMatchObject({ archived: 1 });
  expect(f.settings.state.getTask(f.task.id)?.archivedWorktreeBranch).toBe(
    "refs/heads/feature/archived-task",
  );
  await host.close();
  const restarted = await reopen(f);
  await restarted.restoreSession(f.task.id);
  expect(await git(f.tree.path, "branch", "--show-current")).toBe("feature/archived-task");
  expect(f.settings.state.getTask(f.task.id)?.archivedWorktreeBranch).toBeUndefined();
});

it("keeps dirty worktrees and their tasks visible with a useful result", async () => {
  const f = await treeFixture();
  await writeFile(join(f.tree.path, "tracked.txt"), "unsaved user changes");
  const host = await reopen(f);
  const result = await host.runAutoArchive(true);
  expect(result).toMatchObject({ archived: 0, skipped: 1 });
  expect(result.details).toEqual([
    expect.objectContaining({ sessionId: f.task.id, reason: expect.stringContaining("未提交") }),
  ]);
  expect(f.settings.state.getTask(f.task.id)?.archivedAt).toBeUndefined();
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("unsaved user changes");
});

it("does not clean a worktree still referenced by an independent task", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  const other = await host.createSession(f.a.id, { cwd: f.tree.path });
  const result = await host.runAutoArchive(true);
  expect(result).toMatchObject({ archived: 0, skipped: 1 });
  expect(result.details[0]?.reason).toContain("其他任务引用");
  expect(existsSync(f.tree.path)).toBe(true);
  expect(host.workspaceInfo(other.id).cwd).toBe(f.tree.path);
  expect(f.settings.state.getTask(f.task.id)?.archivedAt).toBeUndefined();
});

it("keeps a worktree while an app terminal uses it and cleans it after the terminal closes", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  let terminalOpen = true;
  host.setWorkspaceInUse((cwd) => terminalOpen && cwd === f.tree.path);
  expect(await host.runAutoArchive(true)).toMatchObject({ archived: 0, skipped: 1 });
  expect(existsSync(f.tree.path)).toBe(true);
  terminalOpen = false;
  expect(await host.runAutoArchive(true)).toMatchObject({ archived: 1, skipped: 0 });
  expect(existsSync(f.tree.path)).toBe(false);
});

it("clears a recovery marker when Git fails after preparation and leaves the checkout intact", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  const head = await git(f.tree.path, "rev-parse", "HEAD");
  vi.spyOn(worktrees, "removeWorktree").mockImplementationOnce(async (_tree, _root, onRemove) => {
    onRemove?.(head);
    throw new Error("injected Git removal failure");
  });
  const result = await host.runAutoArchive(true);
  expect(result).toMatchObject({ archived: 0, skipped: 1 });
  expect(result.details[0]?.reason).toContain("injected Git removal failure");
  expect(f.settings.state.getTask(f.task.id)?.archivedAt).toBeUndefined();
  expect(f.settings.state.getTask(f.task.id)?.archivedWorktreeHead).toBeUndefined();
  expect(existsSync(f.tree.path)).toBe(true);
});

it("waits for an admitted workspace operation before a later scan can clean the checkout", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  const entered = deferred();
  const release = deferred();
  const operation = host.withWorkspace(f.task.id, async (cwd) => {
    expect(cwd).toBe(f.tree.path);
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  try {
    expect(await host.runAutoArchive(true)).toMatchObject({ archived: 0 });
    expect(existsSync(f.tree.path)).toBe(true);
  } finally {
    release.resolve();
    await operation;
  }
  expect(await host.runAutoArchive(true)).toMatchObject({ archived: 1, skipped: 0 });
  expect(existsSync(f.tree.path)).toBe(false);
});

it("preserves the recovery ref and reservation when deletion is rejected before commit", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  const head = await git(f.tree.path, "rev-parse", "HEAD");
  const ref = `refs/zpi/archived-worktrees/${f.tree.id}`;
  await host.runAutoArchive(true);
  vi.spyOn(host.plugins, "beforeDelete").mockRejectedValueOnce(new Error("injected delete rejection"));
  await expect(host.deleteSession(f.task.id)).rejects.toThrow("injected delete rejection");
  expect(f.settings.state.getTask(f.task.id)).toMatchObject({
    archivedAt: expect.any(Number),
    archivedWorktreeHead: head,
  });
  expect(await git(f.a.path, "rev-parse", ref)).toBe(head);
  expect(existsSync(dirname(f.tree.path))).toBe(true);
  expect(existsSync(f.tree.path)).toBe(false);
  await host.restoreSession(f.task.id);
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(head);
  expect(host.getSessionSnapshot(f.task.id).session.archivedAt).toBeNull();
});

it("retries a failed recovery-ref release after durable deletion and restart", async () => {
  const f = await treeFixture();
  const host = await reopen(f);
  const head = await git(f.tree.path, "rev-parse", "HEAD");
  const ref = `refs/zpi/archived-worktrees/${f.tree.id}`;
  await host.runAutoArchive(true);
  const release = vi
    .spyOn(worktrees, "releaseArchivedWorktree")
    .mockRejectedValueOnce(new Error("injected Git release failure"));
  await host.deleteSession(f.task.id);
  expect(release).toHaveBeenCalledOnce();
  expect(f.settings.state.getTask(f.task.id)).toBeUndefined();
  expect(host.listArchivedSessions()).toEqual([]);
  expect(f.settings.state.pendingCleanup()).toContainEqual({
    kind: "task",
    taskId: f.task.id,
    path: "",
  });
  expect(await git(f.a.path, "rev-parse", ref)).toBe(head);
  expect(existsSync(dirname(f.tree.path))).toBe(true);
  await host.close();
  const recovered = await reopen(f);
  expect(release).toHaveBeenCalledTimes(2);
  expect(f.settings.state.pendingCleanup()).toEqual([]);
  expect(recovered.listArchivedSessions()).toEqual([]);
  expect(existsSync(dirname(f.tree.path))).toBe(false);
  await expect(git(f.a.path, "rev-parse", "--verify", ref)).rejects.toThrow();
});

it("scans once on startup, scans every five minutes, and stops its timer on close", async () => {
  const f = await fixture((_, response) => done(response));
  const old = await f.host.createSession(f.a.id);
  const newer = await f.host.createSession(f.a.id);
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  f.settings.updateAutoArchive({ enabled: true, olderThanDays: 7 });
  await f.host.close();
  seed(f, old.id);
  seed(f, newer.id, { updatedAt: now - 7 * day + 1000 });
  const host = await reopen(f);
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  host.startAutoArchive();
  host.startAutoArchive();
  await expect.poll(() => f.settings.state.getTask(old.id)?.archivedAt).toEqual(expect.any(Number));
  expect(f.settings.state.getTask(newer.id)?.archivedAt).toBeUndefined();
  expect(vi.getTimerCount()).toBe(1);
  now += 1001;
  await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
  await expect.poll(() => f.settings.state.getTask(newer.id)?.archivedAt).toEqual(expect.any(Number));
  await host.close();
  expect(vi.getTimerCount()).toBe(0);
});
