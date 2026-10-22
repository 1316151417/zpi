import { lstat, readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { createTwoFilesPatch } from "diff";
import type { DiffItem } from "../shared/bridge.ts";
import type { ReviewSnapshot, ReviewSource } from "../shared/review.ts";
import { isPathInside } from "./path-bounds.ts";
import { workspaceGitStatus } from "./workspace-directory.ts";
import { runGit } from "./workspace-files.ts";

async function comparison(cwd: string, source: ReviewSource): Promise<string[]> {
  if (source === "staged") return ["--cached"];
  if (source !== "branch") return [];
  try {
    // 与 ZCode 相同：比较上游分支的 merge-base 与 HEAD，不混入工作区改动。
    const upstream = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim();
    return [`${upstream}...HEAD`];
  } catch {
    return [];
  }
}

function parseStats(output: string, root: string): DiffItem[] {
  const records = output.split("\0");
  const entries: DiffItem[] = [];
  for (let i = 0; i < records.length; i++) {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/.exec(records[i]);
    if (!match) continue;
    let path = match[3];
    let oldPath: string | undefined;
    if (!path) {
      oldPath = resolve(root, records[++i]);
      path = records[++i];
    }
    const binary = match[1] === "-";
    entries.push({
      id: `file:${resolve(root, path)}`,
      path: resolve(root, path),
      oldPath,
      status: oldPath ? "renamed" : "modified",
      area: "",
      added: Number(match[1]) || 0,
      removed: Number(match[2]) || 0,
      patchAvailable: !binary,
      ...(binary ? { reason: "无法预览二进制 Diff" } : {}),
    });
  }
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()];
}

export async function gitReview(
  cwd: string,
  source: ReviewSource,
  onlyPath?: string,
): Promise<ReviewSnapshot> {
  if (onlyPath && !isPathInside(resolve(cwd), resolve(onlyPath)))
    throw new Error("invalid_input: 文件不在当前工作区内");
  const status = await workspaceGitStatus(cwd);
  if (!status.summary.isRepository)
    return {
      entries: [],
      isRepository: false,
      ...(!status.summary.isGitAvailable ? { isGitAvailable: false } : {}),
    };
  const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const refs = await comparison(cwd, source);
  if (source === "branch" && !refs.length) return { entries: [], isRepository: true };
  const entries = parseStats(
    await runGit(cwd, [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--numstat",
      "-z",
      "--find-renames",
      ...refs,
      "--",
      ".",
    ]),
    root,
  );
  const changes = source === "staged" ? status.stagedChanges : status.unstagedChanges;
  for (const entry of entries) {
    const change = changes.find((change) => change.path === entry.path);
    if (source !== "branch" && change) entry.status = change.kind === "added" ? "created" : change.kind;
    if (source !== "branch" && change?.isConflicted) {
      entry.reason = "文件存在合并冲突，请先解决冲突后查看差异";
      entry.patchAvailable = false;
    }
  }
  if (source === "unstaged") {
    for (const change of changes.filter(
      (change) => change.isUntracked && (!onlyPath || change.path === onlyPath),
    )) {
      const info = await lstat(change.path);
      const bytes = info.isFile() && info.size <= 2 * 1024 * 1024 ? await readFile(change.path) : null;
      const text = bytes && !bytes.includes(0) ? bytes.toString("utf8") : null;
      entries.push({
        id: `file:${change.path}`,
        path: change.path,
        status: "created",
        area: "",
        added: text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0,
        removed: 0,
        patchAvailable: text !== null,
        ...(text === null ? { reason: "文件过大或为二进制文件，暂不支持差异预览" } : {}),
      });
    }
  }
  return {
    entries: entries
      .filter((entry) => !onlyPath || entry.path === onlyPath)
      .sort((a, b) => a.path.localeCompare(b.path)),
    isRepository: true,
  };
}

export async function gitReviewPatch(cwd: string, source: ReviewSource, path: string): Promise<string> {
  // 仅接受当前来源中存在的路径；参数经 -- 分隔，禁用用户配置的外部 diff/textconv。
  const entry = (await gitReview(cwd, source, path)).entries.find((entry) => entry.path === path);
  if (!entry) throw new Error("not_found: 此来源下的文件改动已不存在，请刷新");
  if (entry.reason) return "";
  const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const file = relative(root, path);
  const status = source === "unstaged" ? await workspaceGitStatus(cwd) : undefined;
  if (status?.unstagedChanges.some((change) => change.path === path && change.isUntracked)) {
    const info = await lstat(path);
    if (!info.isFile() || info.size > 2 * 1024 * 1024) throw new Error("invalid_input: 文件过大");
    const bytes = await readFile(path);
    if (bytes.includes(0)) return "";
    return createTwoFilesPatch("/dev/null", file, "", bytes.toString("utf8"));
  }
  const refs = await comparison(cwd, source);
  if (source === "branch" && !refs.length) throw new Error("not_found: 上游分支不可用");
  return runGit(root, [
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--find-renames",
    ...refs,
    "--",
    file,
    ...(entry.oldPath ? [relative(root, entry.oldPath)] : []),
  ]);
}
