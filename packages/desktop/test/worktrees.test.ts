import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import * as worktrees from "../src/main/worktrees.ts";
import { createWorktree, gitEnvironment, resolveWorktreeBase } from "../src/main/worktrees.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

const exec = promisify(execFile);
afterEach(() => vi.restoreAllMocks());
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}
async function repo(cwd: string) {
  await git(cwd, "init", "-b", "main");
  await git(cwd, "config", "user.email", "test@example.test");
  await git(cwd, "config", "user.name", "Test");
  await writeFile(join(cwd, "tracked.txt"), "committed");
  await git(cwd, "add", ".");
  await git(cwd, "commit", "-m", "Initial");
}

it("creates detached worktrees from HEAD without adding branches or changing uncommitted source files", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  const head = await git(f.a.path, "rev-parse", "HEAD");
  await writeFile(join(f.a.path, "tracked.txt"), "dirty");
  const branches = await git(f.a.path, "for-each-ref", "--format=%(refname)", "refs/heads/");
  const tree = await createWorktree(f.a.path, join(f.dir, "trees"));
  expect(tree.id).toMatch(/^[a-z0-9]{4}$/);
  expect(tree.path).toBe(join(f.dir, "trees", tree.id, "a"));
  expect(await git(tree.path, "rev-parse", "HEAD")).toBe(head);
  expect(await git(tree.path, "branch", "--show-current")).toBe("");
  expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("committed");
  expect(await readFile(join(f.a.path, "tracked.txt"), "utf8")).toBe("dirty");
  const second = await createWorktree(f.a.path, join(f.dir, "trees"));
  expect(second.id).not.toBe(tree.id);
  expect(await git(f.a.path, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe(branches);
  expect(await gitEnvironment(f.b.path)).toBeNull();
});

it("lists local and fetched remote branches separately and creates detached worktrees from either", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  const initial = await git(f.a.path, "rev-parse", "HEAD");
  await git(f.a.path, "checkout", "-b", "feature/topic");
  await writeFile(join(f.a.path, "tracked.txt"), "local feature");
  await git(f.a.path, "commit", "-am", "Feature");
  const local = await git(f.a.path, "rev-parse", "HEAD");
  // Fetch from another repository so the list represents actual remote-tracking refs.
  await repo(f.b.path);
  await git(f.b.path, "checkout", "-b", "feature/topic");
  await writeFile(join(f.b.path, "tracked.txt"), "remote feature");
  await git(f.b.path, "commit", "-am", "Remote feature");
  const remote = await git(f.b.path, "rev-parse", "HEAD");
  await git(f.a.path, "remote", "add", "origin", f.b.path);
  await git(f.a.path, "fetch", "origin");
  await git(f.a.path, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git(f.a.path, "checkout", "main");
  await writeFile(join(f.a.path, "tracked.txt"), "dirty");
  const environment = await gitEnvironment(f.a.path);
  expect(environment).toMatchObject({ branch: "main", head: initial, currentRef: "refs/heads/main" });
  expect(environment?.branches).toContainEqual({
    ref: "refs/heads/feature/topic",
    name: "feature/topic",
    remote: false,
  });
  expect(environment?.branches).toContainEqual({
    ref: "refs/remotes/origin/feature/topic",
    name: "origin/feature/topic",
    remote: true,
  });
  expect(environment?.branches.some((branch) => branch.ref === "refs/remotes/origin/HEAD")).toBe(false);
  const branches = await git(f.a.path, "for-each-ref", "--format=%(refname)", "refs/heads/");
  for (const [ref, head, content] of [
    ["refs/heads/feature/topic", local, "local feature"],
    ["refs/remotes/origin/feature/topic", remote, "remote feature"],
  ]) {
    const tree = await createWorktree(f.a.path, join(f.dir, "trees"), undefined, ref);
    expect(tree.id).toMatch(/^[a-z0-9]{4}$/);
    expect(await git(tree.path, "rev-parse", "HEAD")).toBe(head);
    expect(await git(tree.path, "branch", "--show-current")).toBe("");
    expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe(content);
  }
  expect(await git(f.a.path, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe(branches);
  expect(await git(f.a.path, "branch", "--show-current")).toBe("main");
  expect(await readFile(join(f.a.path, "tracked.txt"), "utf8")).toBe("dirty");
  expect(await git(f.a.path, "rev-parse", "refs/heads/feature/topic")).toBe(local);
  expect(await git(f.a.path, "rev-parse", "refs/remotes/origin/feature/topic")).toBe(remote);
});

it("rejects missing branches and revision expressions and supports a detached starting commit", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  for (const ref of ["main", "--help", "refs/heads/main~1", "refs/heads/main^{commit}"])
    await expect(resolveWorktreeBase(f.a.path, ref)).rejects.toThrow("无效起始分支");
  await expect(
    createWorktree(f.a.path, join(f.dir, "trees"), undefined, "refs/heads/deleted"),
  ).rejects.toThrow("起始分支不存在");
  const head = await git(f.a.path, "rev-parse", "HEAD");
  await git(f.a.path, "checkout", "--detach");
  expect(await gitEnvironment(f.a.path)).toMatchObject({ currentRef: null, head });
  const tree = await createWorktree(f.a.path, join(f.dir, "trees"), undefined, "HEAD");
  expect(await git(tree.path, "rev-parse", "HEAD")).toBe(head);
});

it("keeps commits in detached worktrees and allows creating a named branch later", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  const sourceHead = await git(f.a.path, "rev-parse", "HEAD");
  const tree = await createWorktree(f.a.path, join(f.dir, "trees"));
  await writeFile(join(tree.path, "tracked.txt"), "worktree commit");
  await git(tree.path, "commit", "-am", "Detached work");
  const head = await git(tree.path, "rev-parse", "HEAD");
  expect(head).not.toBe(sourceHead);
  expect(await git(tree.path, "branch", "--show-current")).toBe("");
  expect(await git(f.a.path, "rev-parse", "HEAD")).toBe(sourceHead);
  expect(await git(f.a.path, "for-each-ref", "--format=%(refname)", "refs/heads/")).toBe("refs/heads/main");
  await git(tree.path, "switch", "-c", "feature/saved-work");
  expect(await git(tree.path, "rev-parse", "refs/heads/feature/saved-work")).toBe(head);
  expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("worktree commit");
});

it("restores existing named worktrees without detaching them or allocating another checkout", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  const path = join(f.dir, "legacy-tree");
  await git(f.a.path, "worktree", "add", "-b", "legacy", path);
  const session = f.host.createSession(f.a.id, { cwd: path });
  await f.host.close();
  const manager = SessionManager.open(join(f.dir, "agent", "sessions", f.a.id, `${session.id}.jsonl`));
  const worktree = { branch: "legacy", path, sourceCwd: f.a.path };
  manager.appendCustomEntry("zpi.environment", { newWorktree: true, worktree });
  const host = new SessionHost(f.dir, f.settings, f.dir);
  await host.init();
  cleanup.push(() => host.close());
  expect(host.getSessionSnapshot(session.id).session.worktree).toEqual(worktree);
  expect(host.workspaceInfo(session.id).cwd).toBe(path);
  await host.startRun({ sessionId: session.id, text: "continue" });
  await host.activeRuns.get(session.id)?.done;
  expect(host.workspaceInfo(session.id).cwd).toBe(path);
  expect(await git(path, "branch", "--show-current")).toBe("legacy");
  expect((await git(f.a.path, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(2);
});

it("restores the chosen starting branch and resolves its latest commit at first send", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  await git(f.a.path, "branch", "feature/topic");
  const session = f.host.createSession(f.a.id);
  expect(await f.host.setNewWorktree(session.id, true)).toMatchObject({ worktreeBaseRef: "refs/heads/main" });
  await f.host.setNewWorktree(session.id, true, "refs/heads/feature/topic");
  await f.host.setNewWorktree(session.id, false);
  expect(await f.host.setNewWorktree(session.id, true)).toMatchObject({
    worktreeBaseRef: "refs/heads/feature/topic",
  });
  expect((await git(f.a.path, "worktree", "list", "--porcelain")).match(/^worktree /gm)).toHaveLength(1);
  expect(f.host.getSessionSnapshot(session.id).session.worktree).toBeUndefined();
  await f.host.close();
  const host = new SessionHost(
    f.dir,
    f.settings,
    f.dir,
    undefined,
    undefined,
    undefined,
    join(f.dir, "trees"),
  );
  await host.init();
  cleanup.push(() => host.close());
  expect(host.getSessionSnapshot(session.id).session).toMatchObject({
    draft: true,
    worktreeBaseRef: "refs/heads/feature/topic",
  });
  await git(f.a.path, "checkout", "feature/topic");
  await writeFile(join(f.a.path, "tracked.txt"), "latest feature");
  await git(f.a.path, "commit", "-am", "Latest feature");
  const head = await git(f.a.path, "rev-parse", "HEAD");
  await git(f.a.path, "checkout", "main");
  await host.startRun({ sessionId: session.id, text: "work" });
  await host.activeRuns.get(session.id)?.done;
  const record = host.getSessionSnapshot(session.id).session;
  expect(await git(record.cwd as string, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(record.cwd as string, "tracked.txt"), "utf8")).toBe("latest feature");
  expect(await git(f.a.path, "branch", "--show-current")).toBe("main");
  await expect(host.setNewWorktree(session.id, true, "refs/heads/main")).rejects.toThrow("首次发送前");
  await writeFile(join(record.cwd as string, "tracked.txt"), "saved detached commit");
  await git(record.cwd as string, "commit", "-am", "Saved detached commit");
  const committedHead = await git(record.cwd as string, "rev-parse", "HEAD");
  await host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.getSessionSnapshot(session.id).session).toMatchObject({
    worktreeBaseRef: "refs/heads/feature/topic",
    worktree: record.worktree,
    cwd: record.cwd,
  });
  expect(await git(restored.workspaceInfo(session.id).cwd, "rev-parse", "HEAD")).toBe(committedHead);
  expect(await git(restored.workspaceInfo(session.id).cwd, "branch", "--show-current")).toBe("");
});

it("reports a deleted starting branch without running the model and retries that branch when restored", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  await git(f.a.path, "branch", "feature/topic");
  const session = f.host.createSession(f.a.id);
  await expect(f.host.setNewWorktree(session.id, true, "refs/heads/missing")).rejects.toThrow(
    "起始分支不存在",
  );
  expect(f.host.getSessionSnapshot(session.id).session.newWorktree).toBeUndefined();
  await f.host.setNewWorktree(session.id, true, "refs/heads/feature/topic");
  await git(f.a.path, "branch", "-D", "feature/topic");
  await f.host.submitInput({ sessionId: session.id, text: "work" });
  await f.host.activeRuns.get(session.id)?.done;
  expect(f.host.getSessionSnapshot(session.id).view.runs[0]).toMatchObject({
    status: "error",
    error: expect.stringContaining("起始分支不存在"),
  });
  expect(f.server.requests).toHaveLength(0);
  expect(f.host.getSessionSnapshot(session.id).session.worktree).toBeUndefined();
  await git(f.a.path, "branch", "feature/topic");
  const actual = worktrees.createWorktree;
  vi.spyOn(worktrees, "createWorktree").mockImplementation((cwd, _root, onProgress, baseRef) =>
    actual(cwd, join(f.dir, "trees"), onProgress, baseRef),
  );
  await f.host.submitInput({ sessionId: session.id, text: "retry" });
  await f.host.activeRuns.get(session.id)?.done;
  expect(f.host.getSessionSnapshot(session.id).view.runs.map((run) => run.status)).toEqual([
    "error",
    "completed",
  ]);
});

it("defers creation until sending and restores the actual worktree for prompts, tools and subsequent sessions", async () => {
  const f = await fixture((_, response, index) => {
    send(
      response,
      chunk(
        index === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "write",
                  type: "function",
                  function: {
                    name: "write",
                    arguments: JSON.stringify({ path: "tracked.txt", content: "agent result" }),
                  },
                },
              ],
            }
          : { content: "ok" },
      ),
    );
    done(response, index === 0 ? "tool_calls" : "stop");
  });
  await repo(f.a.path);
  await f.host.close();
  const root = join(f.dir, "trees");
  const host = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined, undefined, root);
  await host.init();
  cleanup.push(() => host.close());
  const session = host.createSession(f.a.id);
  await host.setNewWorktree(session.id, true);
  expect(host.workspaceInfo(session.id).cwd).toBe(f.a.path);
  await writeFile(join(f.a.path, "tracked.txt"), "second");
  await git(f.a.path, "commit", "-am", "Second");
  const head = await git(f.a.path, "rev-parse", "HEAD");
  await host.startRun({ sessionId: session.id, text: "work" });
  await host.activeRuns.get(session.id)?.done;
  const record = host.getSessionSnapshot(session.id).session;
  expect(record.worktree?.id).toMatch(/^[a-z0-9]{4}$/);
  expect(record.cwd).toBe(join(root, record.worktree?.id as string, "a"));
  expect(record.cwd).toBe(record.worktree?.path);
  expect(await git(record.cwd as string, "rev-parse", "HEAD")).toBe(head);
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain(record.cwd);
  expect(host.sessions.get(session.id)?.systemPrompt).toContain(record.cwd);
  expect(await readFile(join(record.cwd as string, "tracked.txt"), "utf8")).toBe("agent result");
  expect(await readFile(join(f.a.path, "tracked.txt"), "utf8")).toBe("second");
  await expect(host.setNewWorktree(session.id, false)).rejects.toThrow("首次发送前");
  await host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined, undefined, root);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.workspaceInfo(session.id).cwd).toBe(record.cwd);
  await restored.startRun({ sessionId: session.id, text: "continue" });
  await restored.activeRuns.get(session.id)?.done;
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain(record.cwd);
  const side = await restored.createSideChat(session.id);
  expect(restored.workspaceInfo(side.id).cwd).toBe(record.cwd);
  const runId = restored.getSessionSnapshot(session.id).view.runs.at(-1)?.runId;
  const fork = await restored.forkSession(session.id, runId as string);
  expect(fork.worktree).toEqual(record.worktree);
  expect(restored.workspaceInfo(fork.id).cwd).toBe(record.cwd);
});

it("acknowledges a send and publishes preparation before checkout while keeping other tasks usable", async () => {
  const gate = deferred();
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "ready" }));
    done(response);
  });
  cleanup.push(async () => gate.resolve());
  await repo(f.a.path);
  const actual = worktrees.createWorktree;
  vi.spyOn(worktrees, "createWorktree").mockImplementation(async (cwd, _root, onProgress) => {
    onProgress?.("正在创建工作树 · abcd…");
    await gate.promise;
    return actual(cwd, join(f.dir, "trees"), onProgress);
  });
  const { host } = f;
  const session = host.createSession(f.a.id);
  await host.setNewWorktree(session.id, true);
  const result = await host.submitInput({ sessionId: session.id, text: "work" });
  if (!("runId" in result)) throw new Error("Expected an accepted run");
  const snapshot = host.getSessionSnapshot(session.id);
  expect(snapshot.session).toMatchObject({ draft: false, running: true });
  expect(snapshot.view.runs).toMatchObject([
    { runId: result.runId, userMessage: "work", status: "running", preparation: "正在创建工作树 · abcd…" },
  ]);
  expect(f.server.requests).toHaveLength(0);
  await expect(host.createSideChat(session.id)).rejects.toThrow("工作树尚未创建");
  expect(host.getSessionSnapshot(host.createSession(f.b.id).id).session.cwd).toBe(f.b.path);
  await expect(host.startRun({ sessionId: session.id, text: "duplicate" })).rejects.toThrow("正在运行");
  const finished = host.activeRuns.get(session.id)?.done;
  gate.resolve();
  await finished;
  const completed = host.getSessionSnapshot(session.id);
  expect(completed.view.runs).toHaveLength(1);
  expect(completed.view.runs[0]).toMatchObject({ status: "completed", preparation: null });
  expect(completed.session.cwd).toBe(completed.session.worktree?.path);
  const side = await host.createSideChat(session.id);
  expect(host.workspaceInfo(side.id).cwd).toBe(completed.session.cwd);
  expect(JSON.stringify(f.server.requests[0].messages)).toContain(completed.session.cwd);
});

it("shows checkout failures in the accepted task and retries creating the worktree before using tools", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  const actual = worktrees.createWorktree;
  vi.spyOn(worktrees, "createWorktree")
    .mockRejectedValueOnce(new Error("checkout failed"))
    .mockImplementation((cwd, _root, onProgress) => actual(cwd, join(f.dir, "trees"), onProgress));
  const session = f.host.createSession(f.a.id);
  await f.host.setNewWorktree(session.id, true);
  await f.host.submitInput({ sessionId: session.id, text: "work" });
  await f.host.activeRuns.get(session.id)?.done;
  const failed = f.host.getSessionSnapshot(session.id);
  expect(failed.view.runs[0]).toMatchObject({
    userMessage: "work",
    status: "error",
    error: "checkout failed",
    preparation: null,
  });
  expect(failed.session.draft).toBe(false);
  expect(f.server.requests).toHaveLength(0);
  expect(await readFile(f.host.sessionPath(session.id), "utf8")).toContain("checkout failed");
  await f.host.submitInput({ sessionId: session.id, text: "retry" });
  await f.host.activeRuns.get(session.id)?.done;
  const retried = f.host.getSessionSnapshot(session.id);
  expect(retried.session.worktree?.path).toBe(retried.session.cwd);
  expect(retried.view.runs.map((run) => run.status)).toEqual(["error", "completed"]);
  expect(JSON.stringify(f.server.requests[0].messages)).toContain(retried.session.cwd);
});

it("does not call the model after stopping during checkout", async () => {
  const gate = deferred();
  const f = await fixture((_, response) => done(response));
  cleanup.push(async () => gate.resolve());
  await repo(f.a.path);
  const actual = worktrees.createWorktree;
  vi.spyOn(worktrees, "createWorktree").mockImplementation(async (cwd, _root, onProgress) => {
    await gate.promise;
    return actual(cwd, join(f.dir, "trees"), onProgress);
  });
  const session = f.host.createSession(f.a.id);
  await f.host.setNewWorktree(session.id, true);
  const { runId } = await f.host.startRun({ sessionId: session.id, text: "work" });
  const stopped = f.host.abortRun({ sessionId: session.id, runId });
  gate.resolve();
  await stopped;
  expect(f.host.getSessionSnapshot(session.id).view.runs[0]).toMatchObject({
    status: "aborted",
    preparation: null,
  });
  expect(f.server.requests).toHaveLength(0);
  expect(f.host.activeRuns.has(session.id)).toBe(false);
});
