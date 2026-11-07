import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { readFileBounded } from "./read-file-bounded.ts";
import type { FileChange } from "./tools/file-change.ts";

export interface FileRewindConflict {
  path: string;
  reason: string;
}
export interface FileRewindOptions {
  checkPath?(path: string): void | Promise<void>;
  readCheckpoint?(path: string): Promise<Buffer>;
}
const maxBytes = 4 * 1024 * 1024;
async function readCheckpoint(path: string): Promise<Buffer> {
  if (!(await lstat(path)).isFile()) throw new Error("无法读取文件 checkpoint");
  return readFileBounded(path, maxBytes);
}

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
  changes: readonly FileChange[],
  options: FileRewindOptions = {},
): Promise<FileRewindPlan> {
  const groups = new Map<string, FileChange[]>();
  for (const change of changes) {
    const group = groups.get(change.path) ?? [];
    group.push(change);
    groups.set(change.path, group);
  }
  const plan: FileRewindPlan = { files: [], conflicts: [] };
  for (const [path, writes] of groups) {
    try {
      const actual = await realpath(path);
      if (actual !== resolve(path)) throw new Error("旧 checkpoint 无法安全还原");
      await options.checkPath?.(actual);
      const first = writes[0],
        last = writes.at(-1) as FileChange;
      if (writes.some((write, i) => i > 0 && write.beforeHash !== writes[i - 1].afterHash))
        throw new Error("当前文件已被外部修改");
      const info = await lstat(actual);
      if (!info.isFile() || info.nlink !== 1 || info.size > maxBytes)
        throw new Error("旧 checkpoint 无法安全还原");
      const current = await readFileBounded(actual, maxBytes);
      if (hash(current) !== last.afterHash) throw new Error("当前文件已被外部修改");
      let before: Buffer | null = null;
      if (first.beforeHash !== null) {
        if (!first.beforeFile) throw new Error("缺少文件 checkpoint");
        before = await (options.readCheckpoint ?? readCheckpoint)(first.beforeFile);
        if (hash(before) !== first.beforeHash) throw new Error("无法读取文件 checkpoint");
      }
      plan.files.push({ path: actual, before, current, mode: info.mode });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      plan.conflicts.push({ path, reason: code ? "无法读取当前文件" : (error as Error).message });
    }
  }
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
function matchesFile(path: string, expected: Buffer | null): boolean {
  try {
    return lstatSync(path).isFile() && expected !== null && readFileSync(path).equals(expected);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return expected === null;
    throw error;
  }
}
/** Keep workspace and transcript together; roll workspace back if the transcript cannot commit. */
export async function applyFileRewind(
  plan: FileRewindPlan,
  commit: () => void | Promise<void>,
): Promise<FileRewindConflict[]> {
  if (plan.conflicts.length) return plan.conflicts;
  const conflicts: FileRewindConflict[] = [];
  for (const file of plan.files) {
    try {
      if (!matchesFile(file.path, file.current)) throw new Error("当前文件已被外部修改");
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
    await commit();
  } catch (error) {
    const failures: Error[] = [];
    for (const file of applied.reverse()) {
      try {
        // commit() yields to other tasks and external editors. Never roll back over their newer content.
        if (!matchesFile(file.path, file.before)) throw new Error("文件已变化，已保留当前状态");
        replaceFile(file.path, file.current, file.mode);
      } catch (cause) {
        failures.push(
          new Error(`${file.path}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause }),
        );
      }
    }
    if (failures.length)
      throw new AggregateError(
        [error, ...failures],
        `文件回退提交失败：${String(error)}；部分文件未回滚：${failures.map((failure) => failure.message).join("；")}`,
        { cause: error },
      );
    throw error;
  }
  return [];
}
