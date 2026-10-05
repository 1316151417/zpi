import { mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createTwoFilesPatch } from "diff";
import { isJsonObject } from "zpi-ai";
import type { FileChange, SessionEntry } from "zpi-coding-agent";
import type { DiffItem } from "../shared/bridge.ts";
import { isPathInside } from "./path-bounds.ts";

async function snapshot(path: string, root: string, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const [actual, directory] = await Promise.all([realpath(path), realpath(root)]);
  if (!isPathInside(directory, actual) || (await stat(actual)).size > maxBytes)
    throw new Error("invalid_input: 文件快照不属于此任务或超限");
  return readFile(actual, "utf8");
}
/** Forked history owns its snapshots, so deleting its parent cannot break file previews. */
export async function copyFileChangeSnapshots(
  entries: SessionEntry[],
  sourceRoot: string,
  targetRoot: string,
): Promise<SessionEntry[]> {
  const copied = structuredClone(entries);
  const paths = new Map<string, string>();
  for (const entry of copied) {
    if (
      entry.type !== "message" ||
      entry.message.role !== "toolResult" ||
      !isJsonObject(entry.message.details) ||
      !isJsonObject(entry.message.details.fileChange)
    )
      continue;
    const change = entry.message.details.fileChange;
    for (const key of ["beforeFile", "afterFile", "patchFile"] as const) {
      const path = change[key];
      if (typeof path !== "string") continue;
      let target = paths.get(path);
      if (!target) {
        try {
          const content = await snapshot(path, sourceRoot, key === "patchFile" ? 8 * 1024 * 1024 : undefined);
          await mkdir(targetRoot, { recursive: true });
          target = join(targetRoot, basename(path));
          await writeFile(target, content, { mode: 0o600 });
          paths.set(path, target);
        } catch (error) {
          // A missing historical artifact must not make an otherwise valid conversation unforkable.
          delete change[key];
          change.reason = `文件快照不可用：${String(error)}`;
          continue;
        }
      }
      change[key] = target;
    }
  }
  return copied;
}
/** Same semantics as ZCode taskChangeSummary: original before -> final after per file. */
export async function fileChanges(changes: FileChange[], root: string, area: string): Promise<DiffItem[]> {
  const groups = new Map<string, FileChange[]>();
  for (const change of changes) {
    const group = groups.get(change.path);
    if (group) group.push(change);
    else groups.set(change.path, [change]);
  }
  const result: DiffItem[] = [];
  for (const [path, writes] of groups) {
    const first = writes[0],
      last = writes.at(-1) as FileChange;
    if (last.afterFile && (first.beforeHash === null || first.beforeFile)) {
      try {
        const [before, after] = await Promise.all([
          first.beforeFile ? snapshot(first.beforeFile, root) : "",
          snapshot(last.afterFile, root),
        ]);
        if (before === after && first.beforeHash !== null) continue;
        const patch = createTwoFilesPatch(
          first.beforeHash === null ? "/dev/null" : path,
          path,
          before,
          after,
          "",
          "",
          { context: 3, timeout: 1000 },
        );
        result.push({
          id: `file:${path}`,
          path,
          status: first.beforeHash === null ? "created" : "modified",
          area,
          patch,
          failed: writes.some((c) => c.failed),
          ...(!patch ? { reason: "文件已变化，比对超时" } : {}),
        });
      } catch (error) {
        result.push({
          id: `file:${path}`,
          path,
          status: last.operation,
          area,
          reason: `文件快照不可用：${String(error)}`,
        });
      }
    } else {
      for (const change of writes) {
        let patch = change.patch;
        if (!patch && change.patchFile) patch = await snapshot(change.patchFile, root, 8 * 1024 * 1024);
        result.push({
          id: `operation:${change.toolCallId}`,
          path,
          status: change.operation,
          area,
          patch,
          reason: change.reason,
          failed: change.failed,
        });
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
