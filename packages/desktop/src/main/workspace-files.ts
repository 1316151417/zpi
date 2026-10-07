import { execFile } from "node:child_process";
import { constants, type Dirent } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import ignore from "ignore";
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
  if (!path || isAbsolute(path) || path.includes("\0"))
    throw new Error("invalid_input: 文件引用必须为相对路径");
  const root = await realpath(cwd),
    actual = await realpath(resolve(cwd, path));
  const info = await stat(actual);
  if (!isPathInside(root, actual) || (!info.isFile() && !info.isDirectory()))
    throw new Error("invalid_input: 引用文件不在当前工作目录内");
  await access(actual, constants.R_OK);
  return actual;
}
export interface FileCandidate {
  path: string;
  name: string;
  absolutePath: string;
  type: "file" | "directory";
}
// ZCode workspaceFileSearch: basename, relative path, then absolute-path keywords.
function fuzzyScore(text: string, query: string): number {
  const normalized = text.trim().toLowerCase();
  if (normalized.startsWith(query)) return normalized.length - query.length;
  const substring = normalized.indexOf(query);
  if (substring !== -1) return 100 + substring;
  let score = 200;
  let start = 0;
  for (const char of query) {
    const index = normalized.indexOf(char, start);
    if (index === -1) return Number.POSITIVE_INFINITY;
    score += index - start;
    start = index + 1;
  }
  return score + normalized.length - query.length;
}
export async function searchFiles(
  cwd: string,
  query: string,
  signal?: AbortSignal,
): Promise<FileCandidate[]> {
  if (typeof query !== "string" || query.length > 500) throw new Error("invalid_input: 文件查询无效");
  const paths = new Map<string, FileCandidate["type"]>();
  let git = false;
  try {
    const files = (
      await runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], signal)
    )
      .split("\0")
      .filter(Boolean);
    git = true;
    for (const path of files) {
      paths.set(path, "file");
      for (let parent = dirname(path); parent !== "."; parent = dirname(parent))
        paths.set(parent, "directory");
    }
  } catch (e) {
    if (signal?.aborted) throw e;
  }
  // Git lists files, but misses empty directories. Walk directories in both modes;
  // retain Git's tracked-file and ignore semantics for file candidates.
  let visited = 0;
  const skip = new Set([".git", "node_modules", "dist", "build", "release", ".next", ".cache", "coverage"]);
  const walk = async (
    dir: string,
    rules: { base: string; matcher: ReturnType<typeof ignore> }[],
    depth: number,
  ) => {
    signal?.throwIfAborted();
    if (depth > 20 || visited >= 15000) return;
    const local = [...rules];
    try {
      local.push({ base: dir, matcher: ignore().add(await readFile(join(dir, ".gitignore"), "utf8")) });
    } catch {}
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      signal?.throwIfAborted();
      if (++visited > 15000) break;
      if (skip.has(entry.name)) continue;
      const full = join(dir, entry.name);
      let directory = entry.isDirectory();
      if (entry.isSymbolicLink()) {
        try {
          directory = (await stat(full)).isDirectory();
        } catch {
          continue;
        }
      }
      let excluded = false;
      for (const rule of local) {
        const decision = rule.matcher.test(
          relative(rule.base, full).replace(/\\/g, "/") + (directory ? "/" : ""),
        );
        if (decision.ignored) excluded = true;
        else if (decision.unignored) excluded = false;
      }
      if (excluded) continue;
      const path = relative(cwd, full);
      if (directory) {
        paths.set(path, "directory");
        if (!entry.isSymbolicLink()) await walk(full, local, depth + 1);
      } else if (!git && (entry.isFile() || entry.isSymbolicLink())) paths.set(path, "file");
    }
  };
  await walk(cwd, [], 0);
  const normalized = query.trim().toLowerCase();
  const candidates = [...paths]
    .sort(([a, typeA], [b, typeB]) => (typeA === typeB ? a.localeCompare(b) : typeA === "directory" ? -1 : 1))
    .map(([path, type]) => ({
      path,
      type,
      score: normalized
        ? Math.min(
            fuzzyScore(basename(path), normalized),
            fuzzyScore(path, normalized) + 25,
            fuzzyScore(resolve(cwd, path), normalized) + 300,
          )
        : type === "file"
          ? 0
          : 1,
    }))
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score);
  const results: FileCandidate[] = [];
  const limit = normalized ? 1000 : 10;
  for (const { path, type } of candidates) {
    signal?.throwIfAborted();
    try {
      const absolutePath = await validatedReference(cwd, path);
      results.push({ path, name: basename(path), absolutePath, type });
    } catch {}
    if (results.length >= limit) break;
  }
  return results;
}
