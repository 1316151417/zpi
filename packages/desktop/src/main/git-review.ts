import { readFile, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { DiffItem } from "../shared/bridge.ts";
import type { ReviewDiffData, ReviewSnapshot, ReviewSource } from "../shared/review.ts";
import { isPathInside } from "./path-bounds.ts";
import { workspaceGitStatus } from "./workspace-directory.ts";
import { runGit } from "./workspace-files.ts";

const previewBytes = 1024 * 1024;

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
    const added = Number(match[1]) || 0;
    const removed = Number(match[2]) || 0;
    entries.push({
      id: `file:${resolve(root, path)}`,
      path: resolve(root, path),
      oldPath,
      status: oldPath
        ? "renamed"
        : added > 0 && removed === 0
          ? "created"
          : removed > 0 && added === 0
            ? "deleted"
            : "modified",
      area: "",
      added,
      removed,
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
  const [gitDir, commonDir] = await Promise.all([
    runGit(cwd, ["rev-parse", "--absolute-git-dir"]),
    runGit(cwd, ["rev-parse", "--git-common-dir"]),
  ]);
  const watchPaths = [
    ...new Set([
      ...(process.platform !== "linux" ? [cwd] : []),
      resolve(cwd, gitDir.trim()),
      resolve(cwd, commonDir.trim()),
    ]),
  ];
  const refs = await comparison(cwd, source);
  if (source === "branch" && !refs.length) return { entries: [], isRepository: true, watchPaths };
  let entries = parseStats(
    await runGit(cwd, [
      "--literal-pathspecs",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
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
  const changesByPath = new Map(changes.map((change) => [change.path, change]));
  if (source === "staged") entries = entries.filter((entry) => !changesByPath.get(entry.path)?.isConflicted);
  for (const entry of entries) {
    const change = changesByPath.get(entry.path);
    if (source !== "branch" && change) {
      entry.status = change.kind === "added" ? "created" : change.kind;
      entry.area = change.isConflicted ? "conflicted" : source;
      if (change.isConflicted) {
        entry.added = 0;
        entry.removed = 0;
      }
    }
  }
  if (source === "unstaged") {
    for (const change of changes.filter(
      (change) => change.isUntracked && (!onlyPath || change.path === onlyPath),
    )) {
      // ZCode excludes untracked entries with no reviewable text (empty, binary, too large or unreadable).
      let text: string;
      try {
        const info = await stat(change.path);
        if (!info.isFile() || info.size > previewBytes) continue;
        const bytes = await readFile(change.path);
        if (bytes.length > previewBytes || bytes.includes(0)) continue;
        text = bytes.toString("utf8");
        if (!text) continue;
      } catch {
        continue;
      }
      entries.push({
        id: `file:${change.path}`,
        path: change.path,
        status: "created",
        area: "untracked",
        added: text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
        removed: 0,
        patchAvailable: true,
      });
    }
  }
  return {
    entries: entries
      .filter((entry) => !onlyPath || entry.path === onlyPath)
      .sort((a, b) => {
        const rank = (entry: DiffItem) =>
          entry.area === "conflicted" ? 2 : entry.area === "untracked" ? 1 : 0;
        return rank(a) - rank(b) || a.path.localeCompare(b.path);
      }),
    isRepository: true,
    watchPaths,
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
    const info = await stat(path);
    if (!info.isFile() || info.size > previewBytes) throw new Error("invalid_input: 文件过大");
    const bytes = await readFile(path);
    if (bytes.includes(0)) return "";
    const text = bytes.toString("utf8").replaceAll("\r\n", "\n");
    const lines = text ? text.split("\n") : [];
    if (text.endsWith("\n")) lines.pop();
    const patch = ["--- /dev/null", `+++ b/${file.replaceAll("\\", "/")}`];
    if (lines.length) {
      patch.push(`@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`));
      if (!text.endsWith("\n")) patch.push("\\ No newline at end of file");
    }
    return `${patch.join("\n")}\n`;
  }
  const refs = await comparison(cwd, source);
  if (source === "branch" && !refs.length) throw new Error("not_found: 上游分支不可用");
  return runGit(root, [
    "--literal-pathspecs",
    "diff",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--find-renames",
    ...refs,
    "--",
    file,
    ...(entry.oldPath ? [relative(root, entry.oldPath)] : []),
  ]);
}

async function gitBlob(cwd: string, ref: string, path: string): Promise<string | null> {
  try {
    const text = await runGit(cwd, ["show", `${ref}:${path}`]);
    return Buffer.byteLength(text) <= previewBytes && !text.includes("\0") ? text : null;
  } catch {
    return null;
  }
}
async function workingContent(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > previewBytes) return null;
    const text = await readFile(path, "utf8");
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}
export async function gitReviewDiff(
  cwd: string,
  source: ReviewSource,
  path: string,
): Promise<ReviewDiffData> {
  const entry = (await gitReview(cwd, source, path)).entries.find((entry) => entry.path === path);
  const empty: ReviewDiffData = {
    path,
    availability: "unavailable",
    patch: null,
    beforeContent: null,
    afterContent: null,
    summary: entry?.reason ?? null,
  };
  if (!entry) return empty;
  if (entry.reason)
    return {
      ...empty,
      availability:
        entry.reason === "Diff 已裁剪"
          ? "truncated"
          : entry.reason.includes("二进制")
            ? "binary"
            : "unavailable",
    };
  let patch: string;
  try {
    patch = await gitReviewPatch(cwd, source, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER")
      return { ...empty, availability: "truncated" };
    return { ...empty, summary: "无法读取此文件的 Git diff" };
  }
  if (!patch) return empty;
  if (Buffer.byteLength(patch) > previewBytes) return { ...empty, availability: "truncated" };
  const root = (await runGit(cwd, ["rev-parse", "--show-toplevel"])).trim();
  const file = relative(root, path).replaceAll("\\", "/");
  let before: string | null;
  let after: string | null;
  if (source === "branch") {
    const upstream = (await runGit(cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"])).trim();
    const base = (await runGit(cwd, ["merge-base", upstream, "HEAD"])).trim();
    [before, after] = await Promise.all([gitBlob(root, base, file), gitBlob(root, "HEAD", file)]);
  } else if (source === "staged") {
    [before, after] = await Promise.all([gitBlob(root, "HEAD", file), gitBlob(root, "", file)]);
  } else {
    const status = await workspaceGitStatus(cwd);
    const untracked = status.unstagedChanges.some((change) => change.path === path && change.isUntracked);
    [before, after] = await Promise.all([
      untracked ? Promise.resolve("") : gitBlob(root, "", file),
      workingContent(path),
    ]);
  }
  // ZCode 只有两侧全文都可用时才启用 MultiFileDiff；缺一侧保留正确 patch，不补造空文件。
  const complete = before !== null && after !== null;
  return {
    ...empty,
    availability: "patch",
    patch,
    beforeContent: complete ? before : null,
    afterContent: complete ? after : null,
  };
}
