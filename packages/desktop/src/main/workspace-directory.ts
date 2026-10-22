import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FSWatcher, watch } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { WorkspaceDirectoryEntry, WorkspaceGitSnapshot } from "../shared/workspace-files.ts";
import { localFileCandidate } from "./local-file-path.ts";
import { runGit } from "./workspace-files.ts";

function directoryPath(cwd: string, path: string) {
  if (!path || path.length > 8192 || path.includes("\0")) throw new Error("invalid_input: 目录路径无效");
  return localFileCandidate(cwd, path, true);
}

export async function readWorkspaceDirectory(cwd: string, path: string): Promise<WorkspaceDirectoryEntry[]> {
  const directoryRoot = directoryPath(cwd, path);
  const entries = await readdir(directoryRoot, { withFileTypes: true });
  const result = await Promise.all(
    entries.map(async (entry): Promise<WorkspaceDirectoryEntry | null> => {
      const path = join(directoryRoot, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          directory = (await stat(path)).isDirectory();
        } catch {
          return null;
        }
      } else if (!directory && !entry.isFile()) return null;
      return {
        path,
        name: entry.name,
        type: directory ? "directory" : "file",
        isSymbolicLink: entry.isSymbolicLink(),
      };
    }),
  );
  return result
    .filter((entry): entry is WorkspaceDirectoryEntry => entry !== null)
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1));
}

export async function workspaceGitStatus(cwd: string): Promise<WorkspaceGitSnapshot> {
  const empty: WorkspaceGitSnapshot = {
    summary: { isGitAvailable: true, isRepository: false },
    stagedChanges: [],
    unstagedChanges: [],
  };
  let root: string;
  try {
    root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") empty.summary.isGitAvailable = false;
    return empty;
  }
  const records = (
    await runGit(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."])
  ).split("\0");
  const result: WorkspaceGitSnapshot = { ...empty, summary: { isGitAvailable: true, isRepository: true } };
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (!record) continue;
    const flags = record.slice(0, 2);
    const path = resolve(root, record.slice(3));
    if (/[RC]/.test(flags)) i++;
    for (const [index, section] of [
      [0, "staged"],
      [1, "unstaged"],
    ] as const) {
      const flag = flags[index];
      if (flag === " " || flag === "!") continue;
      if (flag === "?" && index === 0) continue;
      const kind =
        flag === "?"
          ? "untracked"
          : flag === "A"
            ? "added"
            : flag === "D"
              ? "deleted"
              : /[RC]/.test(flag)
                ? "renamed"
                : "modified";
      const change = {
        path,
        kind,
        section: kind === "untracked" ? "untracked" : section,
        isUntracked: kind === "untracked",
        ...(/[U]/.test(flags) || flags === "AA" || flags === "DD" ? { isConflicted: true } : {}),
      } as const;
      (section === "staged" ? result.stagedChanges : result.unstagedChanges).push(change);
    }
  }
  return result;
}

export async function ignoredWorkspacePaths(cwd: string, paths: unknown): Promise<string[]> {
  if (!Array.isArray(paths) || paths.length > 100000 || paths.some((path) => typeof path !== "string"))
    throw new Error("invalid_input: 文件路径列表无效");
  const candidates = paths.map((path) => directoryPath(cwd, path));
  if (!candidates.length) return [];
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      ["check-ignore", "--no-index", "-z", "--stdin"],
      {
        cwd,
        timeout: 5000,
        maxBuffer: 8 * 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      },
      (error, stdout) => {
        if (error && (error as unknown as { code: number }).code !== 1) reject(error);
        else resolve(stdout.split("\0").filter(Boolean));
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(`${candidates.join("\0")}\0`);
  });
}

/** Only renderer-owned, explicitly expanded directories hold native watch handles. */
export class WorkspaceDirectoryWatchers {
  private watchers = new Map<string, FSWatcher>();
  private changed: (id: string, dirPath: string) => void;
  constructor(changed: (id: string, dirPath: string) => void) {
    this.changed = changed;
  }
  watch(cwd: string, path: string) {
    const dirPath = directoryPath(cwd, path);
    const id = randomUUID();
    const watcher = watch(dirPath, { persistent: false }, () => this.changed(id, dirPath));
    watcher.on("error", () => {
      this.changed(id, dirPath);
      this.unwatch(id);
    });
    this.watchers.set(id, watcher);
    return { id };
  }
  unwatch(id: string) {
    this.watchers.get(id)?.close();
    this.watchers.delete(id);
  }
  close() {
    for (const id of this.watchers.keys()) this.unwatch(id);
  }
}
