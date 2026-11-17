import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { GitEnvironment } from "../shared/bridge.ts";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
export async function gitEnvironment(cwd: string): Promise<GitEnvironment | null> {
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
    const [head, branch, refs] = await Promise.all([
      git(cwd, ["rev-parse", "--verify", "HEAD"]),
      git(cwd, ["branch", "--show-current"]),
      git(cwd, ["for-each-ref", "--format=%(refname)%09%(symref)", "refs/heads/", "refs/remotes/"]),
    ]);
    const branches = refs
      .split("\n")
      .filter(Boolean)
      .flatMap((line) => {
        const [ref, symbolic] = line.split("\t");
        if (symbolic) return [];
        const remote = ref.startsWith("refs/remotes/");
        return [{ ref, name: ref.slice(remote ? "refs/remotes/".length : "refs/heads/".length), remote }];
      });
    return {
      branch: branch || head.slice(0, 7),
      head,
      currentRef: branch ? `refs/heads/${branch}` : null,
      branches,
    };
  } catch {
    return null;
  }
}
export async function resolveWorktreeBase(cwd: string, ref: string): Promise<string> {
  if (typeof ref !== "string" || (ref !== "HEAD" && !/^refs\/(heads|remotes)\//.test(ref)))
    throw new Error("invalid_input: 无效起始分支");
  if (ref !== "HEAD") {
    try {
      await git(cwd, ["check-ref-format", ref]);
    } catch {
      throw new Error("invalid_input: 无效起始分支");
    }
  }
  try {
    return await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
  } catch {
    throw new Error("configuration: 起始分支不存在或没有可用提交，请重新选择");
  }
}
export async function createWorktree(
  sourceCwd: string,
  root = join(homedir(), ".zpi", "worktree"),
  onProgress?: (message: string) => void,
  baseRef?: string,
) {
  onProgress?.("正在检查 Git 项目…");
  const environment = await gitEnvironment(sourceCwd);
  if (!environment) throw new Error("configuration: 新工作树需要已有提交的 Git 项目");
  const head = baseRef === undefined ? environment.head : await resolveWorktreeBase(sourceCwd, baseRef);
  const repository = await git(sourceCwd, ["rev-parse", "--show-toplevel"]);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = randomBytes(2).toString("hex");
    const directory = join(root, id);
    const path = join(directory, basename(repository));
    try {
      await mkdir(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // Resolve once so changes to the source branch during checkout cannot change the base.
    onProgress?.(`正在创建工作树 · ${id}…`);
    try {
      await git(repository, ["worktree", "add", "--detach", path, head]);
    } catch (error) {
      // Only remove our empty reservation; Git may have left a partial checkout.
      await rmdir(directory).catch(() => {});
      throw error;
    }
    return { id, path, sourceCwd };
  }
  throw new Error("storage: 无法分配工作树名称，请重试");
}

interface ManagedWorktree {
  id?: string;
  path: string;
  sourceCwd: string;
}
async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return join(await canonicalPath(dirname(path)), basename(path));
  }
}
async function managedWorktreeLocation(worktree: ManagedWorktree, root: string) {
  if (typeof worktree.id !== "string" || !/^[a-f0-9]{4}$/.test(worktree.id))
    throw new Error("storage: 工作树不属于 ZPI 管理目录");
  const repository = await git(worktree.sourceCwd, ["rev-parse", "--show-toplevel"]);
  const directory = join(resolve(root), worktree.id);
  const path = join(directory, basename(repository));
  if (resolve(worktree.path) !== path) throw new Error("storage: 工作树不属于 ZPI 管理目录");
  const canonicalRoot = await canonicalPath(resolve(root));
  const expected = join(canonicalRoot, worktree.id, basename(repository));
  // 管理目录中的符号链接不能把清理操作导向用户的其他目录。
  for (const [candidate, canonical] of [
    [directory, join(canonicalRoot, worktree.id)],
    [path, expected],
  ]) {
    try {
      const info = await lstat(candidate);
      if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(candidate)) !== canonical)
        throw new Error("storage: 工作树管理目录包含不安全路径");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  const listing = await git(repository, ["worktree", "list", "--porcelain", "-z"]);
  const entries = listing
    .split("\0\0")
    .filter(Boolean)
    .map((entry) => {
      const fields = entry.split("\0");
      const field = fields.find((value) => value.startsWith("worktree "));
      if (!field) throw new Error("storage: 无法确认 Git 工作树归属");
      return {
        path: field.slice("worktree ".length),
        branch: fields.find((value) => value.startsWith("branch "))?.slice("branch ".length),
      };
    });
  const canonicalPaths = await Promise.all(entries.map((entry) => canonicalPath(entry.path)));
  const position = canonicalPaths.indexOf(expected);
  if (position === 0) throw new Error("storage: 不能清理项目主工作目录");
  return {
    repository,
    directory,
    path,
    expected,
    registered: position > 0,
    archiveRef: `refs/zpi/archived-worktrees/${worktree.id}`,
    branchOwners: new Map(
      entries.flatMap((entry, index) => (entry.branch ? [[entry.branch, canonicalPaths[index]]] : [])),
    ),
  };
}
async function presentDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
async function verifyWorktree(repository: string, path: string, expected: string): Promise<string> {
  const [top, common, sourceCommon, head] = await Promise.all([
    git(path, ["rev-parse", "--show-toplevel"]),
    git(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(repository, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(path, ["rev-parse", "--verify", "HEAD"]),
  ]);
  if ((await realpath(top)) !== expected || (await realpath(common)) !== (await realpath(sourceCommon)))
    throw new Error("storage: 工作树的 Git 归属不匹配");
  return head;
}
async function removeEmptyContainer(directory: string): Promise<void> {
  try {
    await rmdir(directory);
  } catch (error) {
    // 只回收空容器；同级额外文件不属于本次清理范围。
    if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
  }
}
async function archivedRefHead(repository: string, ref: string): Promise<string | undefined> {
  try {
    return await git(repository, ["rev-parse", "--verify", "--quiet", ref]);
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}
async function deleteArchiveRef(repository: string, ref: string, head: string): Promise<void> {
  const current = await archivedRefHead(repository, ref);
  if (!current) return;
  if (current !== head.toLowerCase()) throw new Error("storage: 工作树恢复引用已变化，无法释放");
  // 比较当前提交后由 Git 原子删除，不能移除其它归档操作已经写入的新引用。
  await git(repository, ["update-ref", "-d", ref, current]);
}
async function worktreeBranch(path: string): Promise<string | undefined> {
  try {
    const branch = await git(path, ["symbolic-ref", "--quiet", "HEAD"]);
    if (!branch.startsWith("refs/heads/")) throw new Error("storage: 工作树分支不属于本地分支");
    return branch;
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return undefined;
    throw error;
  }
}

/** Remove only an owned, clean checkout whose commits remain reachable through ordinary Git refs. */
export async function removeWorktree(
  worktree: ManagedWorktree,
  root: string,
  onRemove?: (head: string, branch?: string) => void,
): Promise<void> {
  const location = await managedWorktreeLocation(worktree, root);
  const exists = await presentDirectory(location.path);
  if (!exists) {
    if (location.registered) throw new Error("storage: 工作树目录已丢失，Git 注册仍存在，请先修复工作树");
    const head = await archivedRefHead(location.repository, location.archiveRef);
    if (!head || (await git(location.repository, ["rev-parse", "--verify", `${head}^{commit}`])) !== head)
      throw new Error("storage: 工作树目录与有效恢复引用均已丢失，无法安全归档");
    // 重试不能只报告目录已清理；调用者仍须持久化可重建的提交，避免恢复时只有归档标志。
    onRemove?.(head);
    await mkdir(location.directory, { recursive: true });
    return;
  }
  if (!location.registered) throw new Error("storage: 工作树未在原项目中注册，无法安全清理");
  const head = await verifyWorktree(location.repository, location.path, location.expected);
  // Git 默认允许删除 ignored 文件，且干净的 detached HEAD 也可能包含尚未挂分支的提交。
  const [changes, exclusiveCommits, branch] = await Promise.all([
    git(location.path, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
      "--ignore-submodules=none",
    ]),
    git(location.path, ["rev-list", "HEAD", "--not", "--branches", "--tags", "--remotes"]),
    worktreeBranch(location.path),
  ]);
  if (changes) throw new Error("busy: 工作树包含未提交、未跟踪或忽略的文件，请先处理后再归档");
  if (exclusiveCommits) throw new Error("busy: 工作树包含尚未保存在分支或标签中的提交，请先保留提交后再归档");
  onRemove?.(head, branch);
  const previous = await archivedRefHead(location.repository, location.archiveRef);
  if (previous && previous !== head) throw new Error("storage: 工作树已有不同的归档恢复引用");
  if (!previous)
    await git(location.repository, ["update-ref", location.archiveRef, head, "0".repeat(head.length)]);
  try {
    await git(location.repository, ["worktree", "remove", "--", location.path]);
  } catch (error) {
    // 删除被锁定等情况仍保留原 checkout，撤回本次新建引用，允许用户处理后切换分支再重试。
    if (!previous && (await presentDirectory(location.path))) {
      try {
        await deleteArchiveRef(location.repository, location.archiveRef, head);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "工作树清理失败且恢复引用回滚未完成");
      }
    }
    throw error;
  }
  // 空容器保留为名称占位，避免新任务复用四位 ID 后阻塞旧任务在原路径恢复。
}

/** Restore the exact checkout path so persisted transcript ownership remains unchanged. */
export async function restoreWorktree(
  worktree: ManagedWorktree,
  root: string,
  head: string,
  branch?: string,
): Promise<void> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error("storage: 无效工作树恢复提交");
  let location = await managedWorktreeLocation(worktree, root);
  if (branch !== undefined) {
    if (!branch.startsWith("refs/heads/")) throw new Error("storage: 无效工作树恢复分支");
    await git(location.repository, ["check-ref-format", branch]);
    await git(location.repository, ["check-ref-format", "--branch", branch.slice("refs/heads/".length)]);
  }
  if (await presentDirectory(location.path)) {
    if (!location.registered) throw new Error("storage: 工作树恢复路径已被其他目录占用");
    if ((await verifyWorktree(location.repository, location.path, location.expected)) !== head.toLowerCase())
      throw new Error("storage: 工作树恢复路径的提交已变化");
    if ((await worktreeBranch(location.path)) !== branch)
      throw new Error("storage: 工作树恢复路径的分支已变化");
    await deleteArchiveRef(location.repository, location.archiveRef, head);
    return;
  }
  if (location.registered) throw new Error("storage: 工作树目录已丢失，Git 注册仍存在，请先修复工作树");
  if ((await git(location.repository, ["rev-parse", "--verify", `${head}^{commit}`])) !== head.toLowerCase())
    throw new Error("storage: 工作树恢复提交不可用");
  await mkdir(location.directory, { recursive: true });
  // mkdir 之后复检归属与符号链接，避免把已有非托管目录当成恢复目标。
  location = await managedWorktreeLocation(worktree, root);
  if (location.registered || (await presentDirectory(location.path)))
    throw new Error("storage: 工作树恢复路径已被占用");
  if (branch) {
    const current = await archivedRefHead(location.repository, branch);
    if (current && current !== head.toLowerCase())
      throw new Error("busy: 原工作树分支已移动，请先处理分支后再恢复");
    if (location.branchOwners.has(branch))
      throw new Error("busy: 原工作树分支已被其他工作树使用，请先释放分支");
    const name = branch.slice("refs/heads/".length);
    await git(
      location.repository,
      current
        ? ["worktree", "add", "--", location.path, name]
        : ["worktree", "add", "-b", name, "--", location.path, head],
    );
  } else {
    await git(location.repository, ["worktree", "add", "--detach", location.path, head]);
  }
  if (
    (await verifyWorktree(location.repository, location.path, location.expected)) !== head.toLowerCase() ||
    (await worktreeBranch(location.path)) !== branch
  )
    throw new Error("storage: 工作树恢复期间提交或分支已变化");
  await deleteArchiveRef(location.repository, location.archiveRef, head);
}

/** Release the small recovery ref and name reservation after the owning task is permanently deleted. */
export async function releaseArchivedWorktree(
  worktree: ManagedWorktree,
  root: string,
  head: string,
): Promise<void> {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(head)) throw new Error("storage: 无效工作树恢复提交");
  const location = await managedWorktreeLocation(worktree, root);
  await deleteArchiveRef(location.repository, location.archiveRef, head);
  await removeEmptyContainer(location.directory);
}
