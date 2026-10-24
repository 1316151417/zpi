import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { syncDirectory } from "../storage-generation.ts";

const exec = promisify(execFile);
export const summaryLimit = 10_000;
export const diffFile = "phase2_workspace_diff.md";
const backupFile = ".summary-backup.json";

export async function readMemoryFile(path: string, maxBytes = 512_000): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`记忆文件必须为普通文件：${path}`);
    if (info.size > maxBytes) throw new Error(`记忆文件超过 ${maxBytes} 字节：${path}`);
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

/** Replace one file atomically; the library itself remains at a fixed path. */
export async function replaceMemoryFile(path: string, content: string, signal?: AbortSignal): Promise<void> {
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    signal?.throwIfAborted();
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    signal?.throwIfAborted();
    await rename(temporary, path);
    syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

export function validateMemorySummary(summary: string): void {
  if (summary.split(/\r?\n/, 1)[0] !== "v1" || Buffer.byteLength(summary, "utf8") >= summaryLimit)
    throw new Error("长期记忆 v2 摘要必须以 v1 开头，且小于 10,000 UTF-8 字节。");
  for (const heading of ["User Profile", "User preferences", "General Tips", "What's in Memory"])
    if (!summary.includes(`## ${heading}`)) throw new Error(`长期记忆摘要缺少章节：${heading}`);
}

/** No inherited Git environment, filters, hooks, signing, network or global config. */
async function git(root: string, args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  const result = await exec(
    "git",
    [
      "-c",
      `core.hooksPath=${join(root, ".git", "disabled-hooks")}`,
      "-c",
      "commit.gpgSign=false",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "user.name=ZPI memory",
      "-c",
      "user.email=memory@zpi.local",
      `--git-dir=${join(root, ".git")}`,
      `--work-tree=${root}`,
      ...args,
    ],
    {
      cwd: root,
      env: {
        ...env,
        GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return result.stdout;
}

export async function resetMemoryBaseline(root: string): Promise<void> {
  await rm(join(root, diffFile), { force: true });
  // Like Codex: one fresh baseline, not a growing history that restores forgotten data.
  await rm(join(root, ".git"), { recursive: true, force: true });
  await git(root, ["init", "--quiet"]);
  await git(root, ["add", "--all", "--", ".", `:!${backupFile}`, `:!${diffFile}`]);
  await git(root, ["commit", "--quiet", "--allow-empty", "-m", "Memory baseline"]);
}

export async function prepareMemoryWorkspace(root: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("记忆工作目录必须为普通目录。");
  await mkdir(join(root, "rollout_summaries"), { recursive: true, mode: 0o700 });
  await rm(join(root, diffFile), { force: true });
  try {
    if (!(await lstat(join(root, ".git"))).isDirectory()) throw new Error("Invalid Git baseline");
    await git(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    await resetMemoryBaseline(root);
  }
}

export async function memoryWorkspaceDiff(root: string): Promise<string> {
  await rm(join(root, diffFile), { force: true });
  // Staging includes newly created files in the diff, just as Codex's baseline scanner does.
  await git(root, ["add", "--all", "--", ".", `:!${backupFile}`, `:!${diffFile}`]);
  return git(root, [
    "diff",
    "--cached",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--unified=3",
    "HEAD",
  ]);
}

/** Only the output needs rollback; synced source inputs are deliberately kept for retry. */
export async function backupMemorySummary(root: string): Promise<void> {
  const path = join(root, "memory_summary.md");
  const content = await readMemoryFile(path, summaryLimit);
  let exists = true;
  try {
    await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  await replaceMemoryFile(join(root, backupFile), JSON.stringify({ exists, content }));
}
export async function recoverMemorySummary(root: string, committedSummary?: string): Promise<void> {
  const backup = await readMemoryFile(join(root, backupFile), summaryLimit * 6 + 128);
  if (!backup) return;
  if (committedSummary) {
    try {
      if ((await readMemoryFile(join(root, "memory_summary.md"), summaryLimit)) === committedSummary) {
        await finishMemorySummary(root);
        return;
      }
    } catch {
      /* Oversized, missing or replaced output must still roll back from the journal. */
    }
  }
  const data: unknown = JSON.parse(backup);
  if (
    !data ||
    typeof data !== "object" ||
    !("exists" in data) ||
    !("content" in data) ||
    typeof data.exists !== "boolean" ||
    typeof data.content !== "string"
  )
    throw new Error("记忆摘要恢复记录无效。");
  if (data.exists) await replaceMemoryFile(join(root, "memory_summary.md"), data.content);
  else await rm(join(root, "memory_summary.md"), { force: true });
  await finishMemorySummary(root);
}
export async function finishMemorySummary(root: string): Promise<void> {
  await rm(join(root, backupFile), { force: true });
}

export async function validateMemoryWorkspace(
  root: string,
  inputs: { path: string; content: string }[],
): Promise<string> {
  const allowed = new Set(["memory_summary.md", backupFile, diffFile, ...inputs.map(({ path }) => path)]);
  const validateEntries = async (directory: string, prefix = "") => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = `${prefix}${entry.name}`;
      if (path === ".git") continue;
      if (
        entry.isSymbolicLink() ||
        (!entry.isDirectory() && !allowed.has(path)) ||
        (entry.isDirectory() && path !== "rollout_summaries")
      )
        throw new Error(`记忆工作目录包含不允许的产物：${path}`);
      if (entry.isDirectory()) await validateEntries(join(directory, entry.name), `${path}/`);
    }
  };
  await validateEntries(root);
  await Promise.all(
    inputs.map(async ({ path, content }) => {
      if ((await readMemoryFile(join(root, path), Math.max(512_000, Buffer.byteLength(content)))) !== content)
        throw new Error(`整合任务修改了只读来源：${path}`);
    }),
  );
  const summary = await readMemoryFile(join(root, "memory_summary.md"), summaryLimit);
  validateMemorySummary(summary);
  const filenames = new Set(inputs.map(({ path }) => path));
  for (const match of summary.matchAll(/rollout_summaries\/[\w.-]+\.md/g))
    if (!filenames.has(match[0])) throw new Error(`整合产物引用不存在或已删除的来源：${match[0]}`);
  return summary;
}
