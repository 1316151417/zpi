import { execFile } from "node:child_process";
import { constants, type Dir } from "node:fs";
import { access, opendir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
import { fuzzyScore } from "zpi-ui/fuzzy-search";
import { splitFileLocation } from "zpi-ui/links";
import type { WorkspaceFileCandidate, WorkspaceFileSearchResult } from "../shared/workspace-files.ts";
import { isPathInside } from "./path-bounds.ts";
export const runGit = async (cwd: string, args: string[], signal?: AbortSignal) =>
  (
    await promisify(execFile)("git", args, {
      cwd,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 5000,
      signal,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_PAGER: "cat" },
    })
  ).stdout;
export async function validatedReference(cwd: string, path: string): Promise<string> {
  if (!path || path.length > 8192 || /[\0\r\n]/.test(path))
    throw new Error("invalid_input: 文件引用路径无效");
  let actual: string;
  try {
    actual = await realpath(resolve(cwd, path));
  } catch (error) {
    // Prefer literal names, including files named "report.ts:284". Only a missing
    // literal target may be interpreted as a copied file/line reference.
    const target = splitFileLocation(path);
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !target?.location.line) throw error;
    actual = await realpath(resolve(cwd, target.path));
  }
  const info = await stat(actual);
  // Explicit absolute references may point outside the project, like file previews.
  // Relative references remain bounded, including symlinks that escape the workspace.
  if (!isAbsolute(path) && !isPathInside(await realpath(cwd), actual))
    throw new Error("invalid_input: 引用文件不在当前工作目录内");
  if (!info.isFile() && !info.isDirectory()) throw new Error("invalid_input: 仅支持引用文件及文件夹");
  await access(actual, constants.R_OK);
  return actual;
}
export type FileCandidate = WorkspaceFileCandidate;
type FileSearchEntry = Pick<FileCandidate, "path" | "type">;
type ScoredCandidate = { entry: FileCandidate; score: number };
const compareCandidates = (a: ScoredCandidate, b: ScoredCandidate) =>
  a.score - b.score ||
  (a.entry.type === b.entry.type
    ? a.entry.path.localeCompare(b.entry.path)
    : a.entry.type === "directory"
      ? -1
      : 1);

/** A cancellable scan keeps only the best matches, never a pre-truncated file index. */
export class WorkspaceFileSearch {
  private candidates: ScoredCandidate[] = [];
  private paths = new Set<string>();
  private truncated = false;
  private incomplete = false;
  private iterator: AsyncGenerator<FileSearchEntry | null>;
  private done = false;
  private normalized: string;
  private cwd: string;
  private signal?: AbortSignal;
  private limit: number;
  private filesOnly: boolean;
  private failedPath(error: unknown) {
    const code = (error as NodeJS.ErrnoException).code;
    // Concurrent deletion/broken symlinks are ordinary omissions; denied or failed IO is not exhaustive.
    if (code && code !== "ENOENT" && code !== "ENOTDIR") this.incomplete = true;
  }
  constructor(cwd: string, query: string, signal?: AbortSignal, limit = 1000, filesOnly = false) {
    if (typeof query !== "string" || query.length > 500) throw new Error("invalid_input: 文件查询无效");
    this.cwd = cwd;
    this.signal = signal;
    this.limit = limit;
    this.filesOnly = filesOnly;
    this.normalized = query.trim().toLowerCase();
    this.iterator = this.scan();
  }
  private async *scan(): AsyncGenerator<FileSearchEntry | null> {
    let git = false;
    try {
      // Git's output remains bounded; its tracked-file semantics include tracked ignored files.
      const files = (
        await runGit(
          this.cwd,
          ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
          this.signal,
        )
      ).split("\0");
      git = true;
      for (const path of files) {
        if (!path) continue;
        this.signal?.throwIfAborted();
        yield { path, type: "file" };
        if (!this.filesOnly)
          for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
            yield { path: parent, type: "directory" };
      }
    } catch (error) {
      this.signal?.throwIfAborted();
      const failure = error as NodeJS.ErrnoException & { killed?: boolean };
      if (failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || failure.killed) this.incomplete = true;
    }
    if (git && this.filesOnly) return;
    const skip = new Set([".git", "node_modules", "dist", "build", "release", ".next", ".cache", "coverage"]);
    const owner = this;
    async function* walk(
      dir: string,
      rules: { base: string; matcher: ReturnType<typeof ignore> }[],
    ): AsyncGenerator<FileSearchEntry | null> {
      owner.signal?.throwIfAborted();
      const local = [...rules];
      try {
        local.push({ base: dir, matcher: ignore().add(await readFile(join(dir, ".gitignore"), "utf8")) });
      } catch (error) {
        owner.failedPath(error);
      }
      let directory: Dir;
      try {
        // Stream directory entries instead of retaining an arbitrarily large readdir result.
        directory = await opendir(dir);
      } catch {
        owner.incomplete = true;
        return;
      }
      try {
        for await (const entry of directory) {
          owner.signal?.throwIfAborted();
          // Yield skipped entries too, so each continuation has a bounded scan budget.
          if (skip.has(entry.name)) {
            yield null;
            continue;
          }
          const full = join(dir, entry.name);
          let isDirectory = entry.isDirectory();
          if (entry.isSymbolicLink()) {
            try {
              isDirectory = (await stat(full)).isDirectory();
            } catch (error) {
              owner.failedPath(error);
              yield null;
              continue;
            }
          }
          let excluded = false;
          for (const rule of local) {
            const decision = rule.matcher.test(
              relative(rule.base, full).replace(/\\/g, "/") + (isDirectory ? "/" : ""),
            );
            if (decision.ignored) excluded = true;
            else if (decision.unignored) excluded = false;
          }
          if (excluded) {
            yield null;
            continue;
          }
          const path = relative(owner.cwd, full);
          if (isDirectory) {
            yield { path, type: "directory" };
            if (!entry.isSymbolicLink()) yield* walk(full, local);
          } else if (!git && (entry.isFile() || entry.isSymbolicLink())) yield { path, type: "file" };
          else yield null;
        }
      } catch {
        owner.signal?.throwIfAborted();
        owner.incomplete = true;
      }
    }
    yield* walk(this.cwd, []);
  }
  private async considerCandidate(item: FileSearchEntry) {
    if ((this.filesOnly && item.type !== "file") || this.paths.has(item.path)) return;
    const name = basename(item.path);
    const absolutePath = resolve(this.cwd, item.path);
    const score = this.normalized
      ? Math.min(
          fuzzyScore(name, this.normalized),
          fuzzyScore(item.path, this.normalized) + 25,
          fuzzyScore(absolutePath, this.normalized) + 300,
        )
      : item.type === "file"
        ? 0
        : 1;
    if (!Number.isFinite(score)) return;
    const candidate = { entry: { ...item, name, absolutePath }, score };
    if (
      this.candidates.length === this.limit &&
      compareCandidates(candidate, this.candidates[this.limit - 1]) >= 0
    ) {
      this.truncated = true;
      return;
    }
    try {
      candidate.entry.absolutePath = await validatedReference(this.cwd, item.path);
      let low = 0,
        high = this.candidates.length;
      while (low < high) {
        const middle = (low + high) >>> 1;
        if (compareCandidates(this.candidates[middle], candidate) <= 0) low = middle + 1;
        else high = middle;
      }
      this.candidates.splice(low, 0, candidate);
      this.paths.add(item.path);
      if (this.candidates.length > this.limit) {
        const removed = this.candidates.pop();
        if (removed) this.paths.delete(removed.entry.path);
        this.truncated = true;
      }
    } catch (error) {
      this.signal?.throwIfAborted();
      this.failedPath(error);
    }
  }
  async nextBatch(maxEntries = 25000, maxMs = 250): Promise<WorkspaceFileSearchResult & { done: boolean }> {
    const started = performance.now();
    for (let visited = 0; !this.done && visited < maxEntries; visited++) {
      this.signal?.throwIfAborted();
      const next = await this.iterator.next();
      this.done = next.done === true;
      if (next.value) await this.considerCandidate(next.value);
      if (performance.now() - started >= maxMs) break;
    }
    this.signal?.throwIfAborted();
    return {
      entries: this.candidates.map(({ entry }) => entry),
      truncated: this.truncated,
      incomplete: this.incomplete,
      done: this.done,
    };
  }
  async close() {
    await this.iterator.return(undefined);
  }
}

export async function searchFiles(
  cwd: string,
  query: string,
  signal?: AbortSignal,
  resultLimit?: number,
): Promise<FileCandidate[]> {
  const scan = new WorkspaceFileSearch(cwd, query, signal, resultLimit ?? (query.trim() ? 1000 : 10));
  try {
    for (;;) {
      const result = await scan.nextBatch();
      if (result.done) return result.entries;
    }
  } finally {
    await scan.close();
  }
}
