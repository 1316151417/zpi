import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
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
export async function validatedFile(cwd: string, path: string): Promise<string> {
  if (!path || isAbsolute(path) || path.includes("\0"))
    throw new Error("invalid_input: 文件引用必须为相对路径");
  const root = await realpath(cwd),
    actual = await realpath(resolve(cwd, path));
  if (!isPathInside(root, actual) || !(await stat(actual)).isFile())
    throw new Error("invalid_input: 引用文件不在当前工作目录内");
  await access(actual, constants.R_OK);
  return actual;
}
export interface FileCandidate {
  path: string;
  name: string;
  absolutePath: string;
}
export async function searchFiles(
  cwd: string,
  query: string,
  signal?: AbortSignal,
): Promise<FileCandidate[]> {
  if (typeof query !== "string" || query.length > 500) throw new Error("invalid_input: 文件查询无效");
  let paths: string[] = [];
  try {
    paths = (
      await runGit(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."], signal)
    )
      .split("\0")
      .filter(Boolean);
  } catch (e) {
    if (signal?.aborted) throw e;
    let visited = 0;
    const skip = new Set([".git", "node_modules", "dist", "build", "release", ".next", ".cache", "coverage"]);
    const walk = async (
      dir: string,
      rules: { base: string; matcher: ReturnType<typeof ignore> }[],
      depth: number,
    ) => {
      if (signal?.aborted) throw new Error("Search cancelled");
      if (depth > 20 || visited > 15000) return;
      const local = [...rules];
      try {
        local.push({ base: dir, matcher: ignore().add(await readFile(join(dir, ".gitignore"), "utf8")) });
      } catch {}
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (++visited > 15000) break;
        const full = join(dir, entry.name);
        let excluded = false;
        for (const rule of local) {
          const decision = rule.matcher.test(
            relative(rule.base, full).replace(/\\/g, "/") + (entry.isDirectory() ? "/" : ""),
          );
          if (decision.ignored) excluded = true;
          else if (decision.unignored) excluded = false;
        }
        if (skip.has(entry.name) || excluded) continue;
        if (entry.isDirectory()) await walk(full, local, depth + 1);
        else if (entry.isFile() || entry.isSymbolicLink()) paths.push(relative(cwd, full));
      }
    };
    await walk(cwd, [], 0);
  }
  const results: FileCandidate[] = [],
    normalized = query.toLowerCase();
  for (const path of [...new Set(paths)].filter((p) => p.toLowerCase().includes(normalized)).slice(0, 500)) {
    if (signal?.aborted) throw new Error("Search cancelled");
    try {
      const absolutePath = await validatedFile(cwd, path);
      results.push({ path, name: basename(path), absolutePath });
    } catch {}
    if (results.length >= 30) break;
  }
  return results;
}
