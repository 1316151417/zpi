// Adapted from ZCode GitPane/helpers.ts (Apache-2.0).
import { getFiletypeFromFileName } from "@pierre/diffs";
import { getPlainTextPatchFallbackLines } from "./patch-preview.ts";
export interface ReviewDiffData {
  path: string;
  availability: "patch" | "binary" | "truncated" | "unavailable";
  patch: string | null;
  beforeContent: string | null;
  afterContent: string | null;
  summary: string | null;
}
type GitDiffResult = ReviewDiffData;
export type GitPaneDiffPreviewPlan =
  | { kind: "rich" }
  | { kind: "patch" }
  | { kind: "plain-text"; lines: string[] };
const MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT = 180_000;
const MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT = 1_200;
function countLogicalLines(content: string | null): number {
  if (!content) {
    return 0;
  }

  let lineCount = content.endsWith("\n") ? 0 : 1;
  for (let index = 0; index < content.length; index += 1) {
    if (content.charCodeAt(index) === 10) {
      lineCount += 1;
    }
  }

  return lineCount;
}

export function shouldRenderPatchOnlyGitDiffPreview(diff: GitDiffResult): boolean {
  if (diff.availability !== "patch" || !diff.patch) {
    return false;
  }

  // Repo 全文读取失败时 patch 仍然有效，但缺失的一侧不能再补成空文件交给
  // MultiFileDiff。把“不完整内容对”并入既有 patch 安全预检，避免整文件误判为增删。
  if (diff.beforeContent === null || diff.afterContent === null) {
    return true;
  }

  const fullContentCharCount = (diff.beforeContent?.length ?? 0) + (diff.afterContent?.length ?? 0);
  if (fullContentCharCount > MAX_RICH_DIFF_FULL_CONTENT_CHAR_COUNT) {
    return true;
  }

  const fullContentLineCount = Math.max(
    countLogicalLines(diff.beforeContent),
    countLogicalLines(diff.afterContent),
  );

  return fullContentLineCount > MAX_RICH_DIFF_FULL_CONTENT_LINE_COUNT;
}

export function getGitPaneDiffPreviewPlan(diff: GitDiffResult | null): GitPaneDiffPreviewPlan {
  if (diff?.availability !== "patch" || !diff.patch) {
    return { kind: "rich" };
  }

  const reviewFallbackLines = shouldRenderPlainTextDiffPreview(diff.patch);
  if (reviewFallbackLines) {
    return {
      kind: "plain-text",
      lines: reviewFallbackLines,
    };
  }

  if (!shouldRenderPatchOnlyGitDiffPreview(diff)) {
    return { kind: "rich" };
  }

  const fullPatchFallbackLines = getPlainTextPatchFallbackLines(diff.patch);
  if (fullPatchFallbackLines) {
    return {
      kind: "plain-text",
      lines: fullPatchFallbackLines,
    };
  }

  // Review 面板展开大文件时，MultiFileDiff 会在 React render 阶段同步比较
  // before/after 整文件，并在初始高亮前构建整文件 plain AST。大文件只需要先看变更 hunk，
  // 因此超阈值时改走 PatchDiff，保留异步高亮 worker，同时避开整文件主线程开销。
  return { kind: "patch" };
}

export function shouldRenderPlainTextDiffPreview(patch: string): string[] | null {
  const fallbackLines = getPlainTextPatchFallbackLines(patch);
  if (!fallbackLines) {
    return null;
  }

  const lines = patch.split(/\r?\n/);
  const isCreatedOrDeletedPatch =
    lines.some((line) => line === "--- /dev/null") || lines.some((line) => line === "+++ /dev/null");
  if (!isCreatedOrDeletedPatch) {
    return fallbackLines;
  }

  const patchFileName = getPatchContentFileName(lines);
  if (!patchFileName) {
    return null;
  }

  // review 面板只该把纯文本新增/删除文件降级成轻量 preview。
  // 底层通用 fallback 为了避免文件变更展开空白，会覆盖 JSON 等结构化文件；
  // 这里重新按文件类型收口，避免结构化文件绕过 PatchDiff 的语义化渲染路径。
  return getFiletypeFromFileName(patchFileName) === "text" ? fallbackLines : null;
}

function getPatchContentFileName(lines: readonly string[]): string | null {
  for (const line of lines) {
    if (!line.startsWith("--- ") && !line.startsWith("+++ ")) {
      continue;
    }

    const fileName = line.slice(4).trim();
    if (!fileName || fileName === "/dev/null") {
      continue;
    }

    return fileName;
  }

  return null;
}
