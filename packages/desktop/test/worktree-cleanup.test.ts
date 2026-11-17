import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import {
  createWorktree,
  releaseArchivedWorktree,
  removeWorktree,
  restoreWorktree,
} from "../src/main/worktrees.ts";

const exec = promisify(execFile);
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
async function git(cwd: string, ...args: string[]) {
  return (await exec("git", ["-C", cwd, ...args])).stdout.trim();
}
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "zpi-worktree-cleanup-")));
  cleanups.push(() => rm(directory, { recursive: true, force: true }));
  const repository = join(directory, "project");
  const root = join(directory, "trees");
  await mkdir(repository);
  await git(repository, "init", "-b", "main");
  await git(repository, "config", "user.email", "test@example.test");
  await git(repository, "config", "user.name", "Test");
  await writeFile(join(repository, "tracked.txt"), "committed\n");
  await writeFile(join(repository, ".gitignore"), "cache/\n");
  await git(repository, "add", ".");
  await git(repository, "commit", "-m", "Initial");
  const tree = await createWorktree(repository, root);
  const head = await git(tree.path, "rev-parse", "HEAD");
  return { directory, repository, root, tree, head };
}

it("removes a clean owned checkout, keeps other worktrees and restores the exact path idempotently", async () => {
  const f = await fixture();
  const other = await createWorktree(f.repository, f.root);
  await writeFile(join(f.repository, "tracked.txt"), "source changes\n");
  const before = vi.fn();
  await removeWorktree(f.tree, f.root, before);
  expect(before).toHaveBeenCalledExactlyOnceWith(f.head, undefined);
  await expect(lstat(f.tree.path)).rejects.toMatchObject({ code: "ENOENT" });
  expect((await lstat(dirname(f.tree.path))).isDirectory()).toBe(true);
  expect(await git(f.repository, "rev-parse", `refs/zpi/archived-worktrees/${f.tree.id}`)).toBe(f.head);
  expect(await readFile(join(f.repository, "tracked.txt"), "utf8")).toBe("source changes\n");
  expect(await git(other.path, "rev-parse", "HEAD")).toBe(f.head);
  const listing = await git(f.repository, "worktree", "list", "--porcelain");
  expect(listing).toContain(other.path);
  expect(listing).not.toContain(f.tree.path);
  await removeWorktree(f.tree, f.root, before);
  expect(before).toHaveBeenCalledTimes(2);
  expect(before).toHaveBeenLastCalledWith(f.head);
  await restoreWorktree(f.tree, f.root, f.head);
  await restoreWorktree(f.tree, f.root, f.head);
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(f.head);
  expect(await git(f.tree.path, "branch", "--show-current")).toBe("");
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("committed\n");
  await expect(
    git(f.repository, "rev-parse", "--verify", `refs/zpi/archived-worktrees/${f.tree.id}`),
  ).rejects.toThrow();
});

it.each(["tracked", "untracked", "ignored"])(
  "retains %s file changes and does not accept removal",
  async (kind) => {
    const f = await fixture();
    const file =
      kind === "tracked"
        ? join(f.tree.path, "tracked.txt")
        : kind === "untracked"
          ? join(f.tree.path, "new.txt")
          : join(f.tree.path, "cache", "data.txt");
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, "must survive\n");
    const before = vi.fn();
    await expect(removeWorktree(f.tree, f.root, before)).rejects.toThrow("未提交、未跟踪或忽略");
    expect(before).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("must survive\n");
    expect(await git(f.repository, "worktree", "list", "--porcelain")).toContain(f.tree.path);
  },
);

it("retains detached commits until a branch or tag preserves them", async () => {
  const f = await fixture();
  await writeFile(join(f.tree.path, "tracked.txt"), "new commit\n");
  await git(f.tree.path, "commit", "-am", "Detached work");
  const head = await git(f.tree.path, "rev-parse", "HEAD");
  await expect(removeWorktree(f.tree, f.root)).rejects.toThrow("尚未保存在分支或标签");
  await git(f.tree.path, "tag", "saved-work");
  await removeWorktree(f.tree, f.root);
  await restoreWorktree(f.tree, f.root, head);
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("new commit\n");
});

it("rejects paths outside the managed layout and never removes the main repository", async () => {
  const f = await fixture();
  for (const tree of [
    { ...f.tree, path: f.repository },
    { ...f.tree, id: "../escape" },
    { ...f.tree, id: undefined },
    { ...f.tree, path: join(f.root, f.tree.id, "other-project") },
  ])
    await expect(removeWorktree(tree, f.root)).rejects.toThrow("ZPI 管理目录");
  const mainParent = join(f.directory, "main-trees", "abcd");
  await mkdir(mainParent, { recursive: true });
  const main = join(mainParent, "main-project");
  await mkdir(main);
  await git(main, "init", "-b", "main");
  await git(main, "config", "user.email", "test@example.test");
  await git(main, "config", "user.name", "Test");
  await git(main, "commit", "--allow-empty", "-m", "Initial");
  await expect(
    removeWorktree({ id: "abcd", path: main, sourceCwd: main }, dirname(mainParent)),
  ).rejects.toThrow("项目主工作目录");
  expect(await git(f.repository, "rev-parse", "HEAD")).toBe(f.head);
  expect(await git(main, "rev-parse", "--is-inside-work-tree")).toBe("true");
});

it.each(["container", "checkout"])("rejects a symbolic link at the %s boundary", async (kind) => {
  const f = await fixture();
  const source = kind === "container" ? dirname(f.tree.path) : f.tree.path;
  const moved = join(f.directory, "moved");
  await rename(source, moved);
  await symlink(moved, source);
  await expect(removeWorktree(f.tree, f.root)).rejects.toThrow("不安全路径");
  await expect(restoreWorktree(f.tree, f.root, f.head)).rejects.toThrow("不安全路径");
  expect(
    await readFile(join(kind === "container" ? join(moved, "project") : moved, "tracked.txt"), "utf8"),
  ).toBe("committed\n");
});

it("does not prune missing registered checkouts or unrelated Git registrations", async () => {
  const f = await fixture();
  const other = await createWorktree(f.repository, f.root);
  await rm(f.tree.path, { recursive: true });
  await rm(other.path, { recursive: true });
  await expect(removeWorktree(f.tree, f.root)).rejects.toThrow("Git 注册仍存在");
  await expect(restoreWorktree(f.tree, f.root, f.head)).rejects.toThrow("Git 注册仍存在");
  const listing = await git(f.repository, "worktree", "list", "--porcelain");
  expect(listing).toContain(f.tree.path);
  expect(listing).toContain(other.path);
});

it("leaves extra container files and refuses an occupied restore path or a changed HEAD", async () => {
  const f = await fixture();
  const extra = join(dirname(f.tree.path), "keep.txt");
  await writeFile(extra, "unrelated");
  await removeWorktree(f.tree, f.root);
  expect(await readFile(extra, "utf8")).toBe("unrelated");
  await mkdir(f.tree.path);
  await writeFile(join(f.tree.path, "keep.txt"), "occupied");
  await expect(restoreWorktree(f.tree, f.root, f.head)).rejects.toThrow("已被其他目录占用");
  expect(await readFile(join(f.tree.path, "keep.txt"), "utf8")).toBe("occupied");
  await rm(f.tree.path, { recursive: true });
  await restoreWorktree(f.tree, f.root, f.head);
  await git(f.tree.path, "commit", "--allow-empty", "-m", "Changed checkout");
  await expect(restoreWorktree(f.tree, f.root, f.head)).rejects.toThrow("提交已变化");
});

it("does not remove a checkout when durable preparation fails and validates restore commits", async () => {
  const f = await fixture();
  await expect(
    removeWorktree(f.tree, f.root, () => {
      throw new Error("persist failed");
    }),
  ).rejects.toThrow("persist failed");
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(f.head);
  await expect(restoreWorktree(f.tree, f.root, "HEAD")).rejects.toThrow("无效工作树恢复提交");
  await removeWorktree(f.tree, f.root);
  await expect(restoreWorktree(f.tree, f.root, "0".repeat(40))).rejects.toThrow();
  await expect(lstat(f.tree.path)).rejects.toMatchObject({ code: "ENOENT" });
});

it("retains an unregistered checkout and refuses to fall back when the source repository is missing", async () => {
  const f = await fixture();
  await expect(
    removeWorktree({ ...f.tree, sourceCwd: join(f.directory, "missing") }, f.root),
  ).rejects.toThrow();
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("committed\n");
  await removeWorktree(f.tree, f.root);
  await mkdir(f.tree.path, { recursive: true });
  await writeFile(join(f.tree.path, "tracked.txt"), "unregistered\n");
  await expect(removeWorktree(f.tree, f.root)).rejects.toThrow("未在原项目中注册");
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("unregistered\n");
});

it("preserves the archived HEAD through branch deletion and immediate Git garbage collection", async () => {
  const f = await fixture();
  await removeWorktree(f.tree, f.root);
  await git(f.repository, "checkout", "--orphan", "unrelated-history");
  await git(f.repository, "rm", "-rf", ".");
  await git(f.repository, "commit", "--allow-empty", "-m", "Unrelated history");
  await git(f.repository, "branch", "-D", "main");
  await git(f.repository, "reflog", "expire", "--expire=now", "--expire-unreachable=now", "--all");
  await git(f.repository, "gc", "--prune=now");
  await restoreWorktree(f.tree, f.root, f.head);
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(f.head);
  expect(await readFile(join(f.tree.path, "tracked.txt"), "utf8")).toBe("committed\n");
  await expect(
    git(f.repository, "rev-parse", "--verify", `refs/zpi/archived-worktrees/${f.tree.id}`),
  ).rejects.toThrow();
});

it("releases archived recovery refs and empty name reservations idempotently, preserving changed refs", async () => {
  const f = await fixture();
  await removeWorktree(f.tree, f.root);
  await releaseArchivedWorktree(f.tree, f.root, f.head);
  await releaseArchivedWorktree(f.tree, f.root, f.head);
  await expect(lstat(dirname(f.tree.path))).rejects.toMatchObject({ code: "ENOENT" });
  await expect(
    git(f.repository, "rev-parse", "--verify", `refs/zpi/archived-worktrees/${f.tree.id}`),
  ).rejects.toThrow();

  await restoreWorktree(f.tree, f.root, f.head);
  await removeWorktree(f.tree, f.root);
  await git(f.repository, "commit", "--allow-empty", "-m", "Another commit");
  const replacement = await git(f.repository, "rev-parse", "HEAD");
  const ref = `refs/zpi/archived-worktrees/${f.tree.id}`;
  await git(f.repository, "update-ref", ref, replacement);
  await expect(releaseArchivedWorktree(f.tree, f.root, f.head)).rejects.toThrow("恢复引用已变化");
  expect(await git(f.repository, "rev-parse", ref)).toBe(replacement);
  expect((await lstat(dirname(f.tree.path))).isDirectory()).toBe(true);
});

it("rejects a missing checkout without an archived HEAD instead of reporting successful archival", async () => {
  const f = await fixture();
  await git(f.repository, "worktree", "remove", "--", f.tree.path);
  const before = vi.fn();
  await expect(removeWorktree(f.tree, f.root, before)).rejects.toThrow("有效恢复引用均已丢失");
  expect(before).not.toHaveBeenCalled();
  expect(await git(f.repository, "rev-parse", "HEAD")).toBe(f.head);
});

it("rolls back a new recovery ref when removal is locked, allowing a different saved HEAD on retry", async () => {
  const f = await fixture();
  const ref = `refs/zpi/archived-worktrees/${f.tree.id}`;
  await git(f.repository, "worktree", "lock", f.tree.path);
  await expect(removeWorktree(f.tree, f.root)).rejects.toThrow("locked");
  await expect(git(f.repository, "rev-parse", "--verify", ref)).rejects.toThrow();
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(f.head);
  await git(f.repository, "worktree", "unlock", f.tree.path);
  await git(f.repository, "commit", "--allow-empty", "-m", "Next saved commit");
  const head = await git(f.repository, "rev-parse", "HEAD");
  await git(f.tree.path, "checkout", "--detach", head);
  const before = vi.fn();
  await removeWorktree(f.tree, f.root, before);
  expect(before).toHaveBeenCalledExactlyOnceWith(head, undefined);
  await restoreWorktree(f.tree, f.root, head);
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(head);
});

it("restores named branch ownership and recreates a deleted original branch at the archived HEAD", async () => {
  const f = await fixture();
  const name = "feature/task";
  const branch = `refs/heads/${name}`;
  await git(f.tree.path, "switch", "-c", name);
  const before = vi.fn();
  await removeWorktree(f.tree, f.root, before);
  expect(before).toHaveBeenCalledExactlyOnceWith(f.head, branch);
  await restoreWorktree(f.tree, f.root, f.head, branch);
  await restoreWorktree(f.tree, f.root, f.head, branch);
  expect(await git(f.tree.path, "symbolic-ref", "HEAD")).toBe(branch);
  await expect(restoreWorktree(f.tree, f.root, f.head)).rejects.toThrow("分支已变化");
  await removeWorktree(f.tree, f.root);
  await git(f.repository, "branch", "-D", name);
  await restoreWorktree(f.tree, f.root, f.head, branch);
  expect(await git(f.tree.path, "symbolic-ref", "HEAD")).toBe(branch);
  expect(await git(f.tree.path, "rev-parse", "HEAD")).toBe(f.head);
});

it.each(["moved", "occupied"])(
  "does not force a named branch restore when the branch is %s",
  async (state) => {
    const f = await fixture();
    const name = "feature/task";
    const branch = `refs/heads/${name}`;
    await git(f.tree.path, "switch", "-c", name);
    await removeWorktree(f.tree, f.root);
    if (state === "moved") {
      await git(f.repository, "commit", "--allow-empty", "-m", "Another commit");
      await git(f.repository, "branch", "-f", name, "HEAD");
    } else {
      await git(f.repository, "worktree", "add", join(f.directory, "another-checkout"), name);
    }
    const branchHead = await git(f.repository, "rev-parse", branch);
    await expect(restoreWorktree(f.tree, f.root, f.head, branch)).rejects.toThrow(
      state === "moved" ? "分支已移动" : "分支已被其他工作树使用",
    );
    expect(await git(f.repository, "rev-parse", branch)).toBe(branchHead);
    expect(await git(f.repository, "rev-parse", `refs/zpi/archived-worktrees/${f.tree.id}`)).toBe(f.head);
    await expect(lstat(f.tree.path)).rejects.toMatchObject({ code: "ENOENT" });
  },
);
