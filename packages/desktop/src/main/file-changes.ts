import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { Worker } from "node:worker_threads";
import { isJsonObject } from "zpi-ai";
import type { FileChange, SessionEntry } from "zpi-coding-agent";
import { readFileBounded } from "zpi-coding-agent";
import type { DiffItem } from "../shared/bridge.ts";
import { isPathInside } from "./path-bounds.ts";

export function entryFileChange(entry: SessionEntry): FileChange | undefined {
  if (
    entry.type !== "message" ||
    entry.message.role !== "toolResult" ||
    !isJsonObject(entry.message.details) ||
    !isJsonObject(entry.message.details.fileChange)
  )
    return undefined;
  return {
    ...(entry.message.details.fileChange as unknown as FileChange),
    failed: entry.message.isError || Boolean(entry.message.details.fileChange.failed),
  };
}

async function snapshotPath(path: string, root: string, maxBytes = 4 * 1024 * 1024): Promise<string> {
  const [actual, directory] = await Promise.all([realpath(path), realpath(root)]);
  if (!isPathInside(directory, actual)) throw new Error("invalid_input: 文件快照不属于此任务或超限");
  const info = await stat(actual);
  if (!info.isFile() || info.size > maxBytes) throw new Error("invalid_input: 文件快照不属于此任务或超限");
  return actual;
}
export async function readFileSnapshot(
  path: string,
  root: string,
  maxBytes = 4 * 1024 * 1024,
): Promise<Buffer> {
  return readFileBounded(await snapshotPath(path, root, maxBytes), maxBytes);
}
/** Forked history owns its snapshots, so deleting its parent cannot break file previews. */
export async function copyFileChangeSnapshots(
  entries: SessionEntry[],
  sourceRoot: string,
  targetRoot: string,
): Promise<SessionEntry[]> {
  const copied = structuredClone(entries);
  const paths = new Map<string, string>();
  let targetReady = false;
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
          const content = await readFileSnapshot(
            path,
            sourceRoot,
            key === "patchFile" ? 8 * 1024 * 1024 : undefined,
          );
          if (!targetReady) {
            await mkdir(targetRoot, { recursive: true });
            targetReady = true;
          }
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
// Serialize one-shot workers across requests; opening several panes must not fan out CPU work.
let pendingPatch: Promise<unknown> = Promise.resolve();
function createFilePatch(
  path: string,
  created: boolean,
  before: string,
  after: string,
  signal?: AbortSignal,
) {
  const job = pendingPatch.then(async () => {
    signal?.throwIfAborted();
    const worker = new Worker(
      new URL(import.meta.url.endsWith(".ts") ? "./diff-worker.ts" : "./diff-worker.js", import.meta.url),
      { workerData: { path, created, before, after } },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    let abort: (() => void) | undefined;
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
        worker.once("exit", (code) => reject(new Error(`diff worker exited before replying (${code})`)));
        // Covers worker startup/failure as well as diff's cooperative computation budget.
        timer = setTimeout(() => resolve(undefined), 5000);
        abort = () => reject(signal?.reason);
        signal?.addEventListener("abort", abort, { once: true });
      });
    } finally {
      clearTimeout(timer);
      if (abort) signal?.removeEventListener("abort", abort);
      await worker.terminate();
    }
  });
  pendingPatch = job.then(
    () => {},
    () => {},
  );
  return job;
}
export interface FileChangesOptions {
  includePatch?: boolean;
  maxPatchBytes?: number;
  signal?: AbortSignal;
}
/** Same semantics as ZCode taskChangeSummary: original before -> final after per file. */
export async function fileChanges(
  changes: FileChange[],
  root: string,
  area: string,
  { includePatch = true, maxPatchBytes = Infinity, signal }: FileChangesOptions = {},
): Promise<DiffItem[]> {
  const groups = new Map<string, FileChange[]>();
  for (const change of changes) {
    const group = groups.get(change.path);
    if (group) group.push(change);
    else groups.set(change.path, [change]);
  }
  const result: DiffItem[] = [];
  for (const [path, writes] of groups) {
    signal?.throwIfAborted();
    const first = writes[0],
      last = writes.at(-1) as FileChange;
    if (last.afterFile && (first.beforeHash === null || first.beforeFile)) {
      try {
        const [beforeBytes, afterBytes] = await Promise.all([
          first.beforeFile ? readFileSnapshot(first.beforeFile, root) : Buffer.alloc(0),
          readFileSnapshot(last.afterFile, root),
        ]);
        const before = beforeBytes.toString("utf8"),
          after = afterBytes.toString("utf8");
        if (before === after && first.beforeHash !== null) continue;
        // Defer large inputs before computing a patch that would only be stripped for IPC.
        const deferred = !includePatch || beforeBytes.length + afterBytes.length > maxPatchBytes;
        const patch = deferred
          ? undefined
          : await createFilePatch(path, first.beforeHash === null, before, after, signal);
        const patchAvailable = deferred || (patch !== undefined && Buffer.byteLength(patch) > maxPatchBytes);
        result.push({
          id: `file:${path}`,
          path,
          status: first.beforeHash === null ? "created" : "modified",
          area,
          patch: patchAvailable ? undefined : patch,
          ...(patchAvailable ? { patchAvailable: true } : {}),
          failed: writes.some((c) => c.failed),
          ...(!patch && !patchAvailable ? { reason: "文件已变化，比对超时" } : {}),
        });
      } catch (error) {
        signal?.throwIfAborted();
        result.push({
          id: `file:${path}`,
          path,
          status: last.operation,
          area,
          failed: writes.some((c) => c.failed),
          reason: `文件快照不可用：${String(error)}`,
          snapshotUnavailable: true,
        });
      }
    } else {
      for (const change of writes) {
        let patch = change.patch,
          reason = change.reason,
          // Old fork records only persisted the diagnostic; translate it at the projection boundary.
          snapshotUnavailable = reason?.startsWith("文件快照不可用") ?? false,
          patchAvailable = false;
        if (!patch && change.patchFile) {
          try {
            const actual = await snapshotPath(change.patchFile, root, 8 * 1024 * 1024);
            if (!includePatch || (await stat(actual)).size > maxPatchBytes) patchAvailable = true;
            else patch = (await readFileBounded(actual, 8 * 1024 * 1024)).toString("utf8");
          } catch (error) {
            reason = `文件快照不可用：${String(error)}`;
            snapshotUnavailable = true;
          }
        }
        if (patch && (!includePatch || Buffer.byteLength(patch) > maxPatchBytes)) {
          patchAvailable = true;
          patch = undefined;
        }
        result.push({
          id: `operation:${change.toolCallId}`,
          path,
          status: change.operation,
          area,
          patch,
          ...(patchAvailable ? { patchAvailable: true } : {}),
          reason,
          ...(snapshotUnavailable ? { snapshotUnavailable: true } : {}),
          failed: change.failed,
        });
      }
    }
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}
