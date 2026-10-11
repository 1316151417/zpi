import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import * as worktrees from "../src/main/worktrees.ts";
import { createWorktree, gitEnvironment } from "../src/main/worktrees.ts";
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

it("creates a four-character branch from HEAD without carrying or changing uncommitted source files", async () => {
  const f = await fixture((_, response) => done(response));
  await repo(f.a.path);
  const head = await git(f.a.path, "rev-parse", "HEAD");
  await writeFile(join(f.a.path, "tracked.txt"), "dirty");
  const tree = await createWorktree(f.a.path, join(f.dir, "trees"));
  expect(tree.branch).toMatch(/^[a-z0-9]{4}$/);
  expect(tree.path).toBe(join(f.dir, "trees", tree.branch, "a"));
  expect(await git(tree.path, "rev-parse", "HEAD")).toBe(head);
  expect(await readFile(join(tree.path, "tracked.txt"), "utf8")).toBe("committed");
  expect(await readFile(join(f.a.path, "tracked.txt"), "utf8")).toBe("dirty");
  const second = await createWorktree(f.a.path, join(f.dir, "trees"));
  expect(second.branch).not.toBe(tree.branch);
  expect(await gitEnvironment(f.b.path)).toBeNull();
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
  const host = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined, [], undefined, root);
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
  expect(record.worktree?.branch).toMatch(/^[a-z0-9]{4}$/);
  expect(record.cwd).toBe(join(root, record.worktree?.branch as string, "a"));
  expect(record.cwd).toBe(record.worktree?.path);
  expect(await git(record.cwd as string, "rev-parse", "HEAD")).toBe(head);
  expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain(record.cwd);
  expect(host.sessions.get(session.id)?.systemPrompt).toContain(record.cwd);
  expect(await readFile(join(record.cwd as string, "tracked.txt"), "utf8")).toBe("agent result");
  expect(await readFile(join(f.a.path, "tracked.txt"), "utf8")).toBe("second");
  await expect(host.setNewWorktree(session.id, false)).rejects.toThrow("首次发送前");
  await host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined, [], undefined, root);
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
