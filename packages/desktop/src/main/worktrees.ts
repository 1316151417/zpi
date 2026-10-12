import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
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
