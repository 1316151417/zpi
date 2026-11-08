import { realpath } from "node:fs/promises";
import { type FileChange, planFileRewind as planRewind } from "@zpi-dev/coding-agent";
import { readFileSnapshot } from "./file-changes.ts";
import { isPathInside } from "./path-bounds.ts";

export { applyFileRewind, type FileRewindPlan } from "@zpi-dev/coding-agent";
/** Desktop restores only its workspace and its owned snapshots. */
export async function planFileRewind(changes: FileChange[], snapshotRoot: string, cwd: string) {
  const workspace = await realpath(cwd);
  const plan = await planRewind(changes, {
    checkPath(path) {
      if (!isPathInside(workspace, path)) throw new Error("旧 checkpoint 无法安全还原");
    },
    readCheckpoint: (path) => readFileSnapshot(path, snapshotRoot),
  });
  if (!changes.length) plan.conflicts.push({ path: "本轮", reason: "本轮没有可安全恢复的文件改动" });
  return plan;
}
