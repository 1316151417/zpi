import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-C", cwd, ...args], { timeout: 30_000, maxBuffer: 1024 * 1024 })).stdout.trim();
}
export async function gitEnvironment(cwd: string): Promise<{ branch: string; head: string } | null> {
  try {
    if ((await git(cwd, ["rev-parse", "--is-inside-work-tree"])) !== "true") return null;
    const [head, branch] = await Promise.all([
      git(cwd, ["rev-parse", "--verify", "HEAD"]),
      git(cwd, ["branch", "--show-current"]),
    ]);
    return { branch: branch || head.slice(0, 7), head };
  } catch {
    return null;
  }
}
export async function createWorktree(
  sourceCwd: string,
  root = join(homedir(), ".zpi", "worktree"),
  onProgress?: (message: string) => void,
) {
  onProgress?.("正在检查 Git 项目…");
  const environment = await gitEnvironment(sourceCwd);
  if (!environment) throw new Error("configuration: 新工作树需要已有提交的 Git 项目");
  const repository = await git(sourceCwd, ["rev-parse", "--show-toplevel"]);
  await mkdir(root, { recursive: true });
  for (let attempt = 0; attempt < 32; attempt++) {
    const branch = randomBytes(2).toString("hex");
    const branchDir = join(root, branch);
    const path = join(branchDir, basename(repository));
    try {
      await git(repository, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      continue;
    } catch (error) {
      if ((error as { code?: number }).code !== 1) throw error;
    }
    try {
      await mkdir(branchDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }
    // Capture HEAD once so switching the source branch during creation cannot change the base.
    onProgress?.(`正在创建工作树 · ${branch}…`);
    try {
      await git(repository, ["worktree", "add", "-b", branch, path, environment.head]);
    } catch (error) {
      // Only remove our empty reservation; Git may have left a partial checkout.
      await rmdir(branchDir).catch(() => {});
      throw error;
    }
    return { branch, path, sourceCwd };
  }
  throw new Error("storage: 无法分配工作树名称，请重试");
}
