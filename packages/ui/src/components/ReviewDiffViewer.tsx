// Adapted from ZCode diff-viewer.tsx and lightweight-diff-preview.tsx (Apache-2.0).
import { MultiFileDiff, PatchDiff } from "@pierre/diffs/react";
import { Component, type CSSProperties, memo, type ReactNode, useMemo } from "react";
import { useAppearance } from "../appearance.ts";
import { getPatchPreviewLineContent, parseTruncatedMarkerOmittedLineCount } from "../patch-preview.ts";
import { getGitPaneDiffPreviewPlan, type ReviewDiffData } from "../review-diff.ts";
import { findHighlightCSS } from "./use-text-find.ts";

class DiffBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <p className="review-diff-fallback">暂时无法预览这个 Diff</p>
    ) : (
      this.props.children
    );
  }
}

function ReviewDiffViewerComponent({
  diff,
  id,
  searching = false,
}: {
  diff: ReviewDiffData;
  id: string;
  searching?: boolean;
}) {
  const { theme } = useAppearance();
  const plan = useMemo(() => getGitPaneDiffPreviewPlan(diff), [diff]);
  const files = useMemo(
    () => ({
      oldFile: {
        name: diff.path,
        contents: diff.beforeContent ?? "",
        cacheKey: `old:${diff.path}:${diff.beforeContent}`,
      },
      newFile: {
        name: diff.path,
        contents: diff.afterContent ?? "",
        cacheKey: `new:${diff.path}:${diff.afterContent}`,
      },
    }),
    [diff.path, diff.beforeContent, diff.afterContent],
  );
  const options = useMemo(
    () => ({
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      disableFileHeader: true,
      hunkSeparators: plan.kind === "rich" ? ("line-info" as const) : ("simple" as const),
      lineDiffType: "word-alt" as const,
      overflow: "scroll" as const,
      theme: { light: "github-light", dark: "github-dark" },
      themeType: theme,
      preferredHighlighter: "shiki-wasm" as const,
      expandUnchanged: searching,
      unsafeCSS: findHighlightCSS,
      onPostRender: (node: HTMLElement) =>
        node.dispatchEvent(new Event("zpi-diff-render", { bubbles: true })),
    }),
    [plan.kind, theme, searching],
  );
  const viewerStyle = {
    "--diffs-bg": "var(--color-bg)",
    "--diffs-light-bg": "var(--color-bg)",
    "--diffs-dark-bg": "var(--color-bg)",
    "--diffs-font-family": "var(--font-code)",
    "--diffs-font-size": "12px",
  } as CSSProperties;
  if (diff.availability !== "patch")
    return (
      <p className="review-diff-fallback">
        {diff.availability === "binary"
          ? "无法预览二进制 Diff"
          : diff.availability === "truncated"
            ? "Diff 已裁剪"
            : "暂时无法预览这个 Diff"}
      </p>
    );
  if (plan.kind === "plain-text")
    return (
      <div className="review-lightweight" data-lightweight-diff-preview>
        <div className="review-lightweight-lines" data-lightweight-diff-scroll-content>
          {plan.lines.map((line, index) => {
            const omitted = parseTruncatedMarkerOmittedLineCount(line);
            if (omitted !== null)
              return (
                <div className="review-diff-truncated" key={index}>
                  Diff 预览已截断：为保持界面流畅，省略了 {omitted} 行。
                </div>
              );
            const kind = line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : "context";
            return (
              <div className={`review-lightweight-line ${kind}`} key={index}>
                <span className="review-lightweight-number" aria-hidden="true">
                  {index + 1}
                </span>
                <code data-find-key={`${id}:plain:${index}`}>{getPatchPreviewLineContent(line) || " "}</code>
              </div>
            );
          })}
        </div>
      </div>
    );
  return (
    <DiffBoundary key={diff.patch}>
      <div className="review-diff-viewer" data-diff-viewer style={viewerStyle}>
        {plan.kind === "patch" && diff.patch ? (
          <PatchDiff patch={diff.patch} options={options} style={viewerStyle} />
        ) : (
          <MultiFileDiff {...files} options={options} style={viewerStyle} />
        )}
      </div>
    </DiffBoundary>
  );
}
export const ReviewDiffViewer = memo(ReviewDiffViewerComponent);
