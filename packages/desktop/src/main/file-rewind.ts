import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { FileChange } from "zpi-coding-agent";
import type { FileRewindConflict } from "zpi-ui";
import { readFileSnapshot } from "./file-changes.ts";
import { isPathInside } from "./path-bounds.ts";

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
interface RestoreFile {
  path: string;
  before: Buffer | null;
  current: Buffer;
  mode: number;
}
export interface FileRewindPlan {
  files: RestoreFile[];
  conflicts: FileRewindConflict[];
}
/** Preflight every checkpoint before touching any workspace file or conversation entry. */
export async function planFileRewind(
  changes: FileChange[],
  snapshotRoot: string,
  cwd: string,
): Promise<FileRewindPlan> {
  const groups = new Map<string, FileChange[]>();
  for (const change of changes) {
    const group = groups.get(change.path) ?? [];
    group.push(change);
    groups.set(change.path, group);
  }
  const plan: FileRewindPlan = { files: [], conflicts: [] };
  const workspace = await realpath(cwd);
  for (const [path, writes] of groups) {
    try {
      const actual = await realpath(path);
      if (actual !== resolve(path) || !isPathInside(workspace, actual))
        throw new Error("旧 checkpoint 无法安全还原");
      const first = writes[0],
        last = writes.at(-1) as FileChange;
      if (writes.some((write, i) => i > 0 && write.beforeHash !== writes[i - 1].afterHash))
        throw new Error("当前文件已被外部修改");
      const info = await stat(actual);
      if (!info.isFile() || info.size > 4 * 1024 * 1024) throw new Error("旧 checkpoint 无法安全还原");
      const current = await readFile(actual);
      if (hash(current) !== last.afterHash) throw new Error("当前文件已被外部修改");
      let before: Buffer | null = null;
      if (first.beforeHash !== null) {
        if (!first.beforeFile) throw new Error("缺少文件 checkpoint");
        before = await readFileSnapshot(first.beforeFile, snapshotRoot);
        if (hash(before) !== first.beforeHash) throw new Error("无法读取文件 checkpoint");
      }
      plan.files.push({ path: actual, before, current, mode: info.mode });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      plan.conflicts.push({ path, reason: code ? "无法读取当前文件" : (error as Error).message });
    }
  }
  if (!groups.size) plan.conflicts.push({ path: "本轮", reason: "本轮没有可安全恢复的文件改动" });
  return plan;
}
function replaceFile(path: string, content: Buffer, mode: number) {
  const temporary = join(dirname(path), `.zpi-rewind-${randomUUID()}`);
  try {
    writeFileSync(temporary, content, { mode, flag: "wx" });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
/** Keep workspace and transcript together; roll workspace back if the transcript cannot commit. */
export function applyFileRewind(plan: FileRewindPlan, commit: () => void): FileRewindConflict[] {
  if (plan.conflicts.length) return plan.conflicts;
  const conflicts: FileRewindConflict[] = [];
  for (const file of plan.files) {
    try {
      if (!lstatSync(file.path).isFile() || !readFileSync(file.path).equals(file.current))
        throw new Error("当前文件已被外部修改");
    } catch (error) {
      conflicts.push({ path: file.path, reason: (error as Error).message });
    }
  }
  if (conflicts.length) return conflicts;
  const applied: RestoreFile[] = [];
  try {
    for (const file of plan.files) {
      if (file.before === null) rmSync(file.path);
      else replaceFile(file.path, file.before, file.mode);
      applied.push(file);
    }
    commit();
  } catch (error) {
    for (const file of applied.reverse()) replaceFile(file.path, file.current, file.mode);
    throw error;
  }
  return [];
}
