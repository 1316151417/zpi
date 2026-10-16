import { PatchDiff } from "@pierre/diffs/react";
import { FileCode2 } from "lucide-react";
import { Component, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "../appearance.ts";
import type { FindMatch, FindRequest, FindState, FindTarget } from "../find.ts";
import { patchFindTargets } from "../patch-find.ts";
import { toolCodeLanguage, useToolTokens } from "./ToolDiff.tsx";
import { findHighlightCSS, useTextFind } from "./use-text-find.ts";
export interface DiffEntry {
  id: string;
  path: string;
  oldPath?: string;
  status: string;
  area: string;
  patch?: string;
  patchAvailable?: boolean;
  reason?: string;
  failed?: boolean;
}
type SingleSideLine = FindTarget & { lineNumber: number; kind: "added" | "removed" };

/** New/deleted files use ZCode's single-gutter lightweight preview, even for small patches. */
function singleSidePatchLines(entry: DiffEntry, patch: string): SingleSideLine[] | undefined {
  const lines = patch.split(/\r?\n/);
  const firstHunk = lines.findIndex((line) => line.startsWith("@@ "));
  if (firstHunk < 0) return;
  const headers = lines.slice(0, firstHunk);
  const added = entry.status === "created" || headers.some((line) => /^--- \/dev\/null(?:\t.*)?$/.test(line));
  const removed =
    entry.status === "deleted" || headers.some((line) => /^\+\+\+ \/dev\/null(?:\t.*)?$/.test(line));
  if (added === removed) return;
  const kind = added ? "added" : "removed";
  const marker = added ? "+" : "-";
  const result: SingleSideLine[] = [];
  let lineNumber = 0,
    remaining = 0;
  for (let index = firstHunk; index < lines.length; index++) {
    const line = lines[index];
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk) {
      const oldCount = Number(hunk[2] ?? 1),
        newCount = Number(hunk[4] ?? 1);
      if (remaining || (added ? oldCount : newCount)) return;
      lineNumber = Number(added ? hunk[3] : hunk[1]);
      remaining = added ? newCount : oldCount;
      continue;
    }
    if (line.startsWith("\\ ") || (!remaining && !line)) continue;
    if (!remaining || line[0] !== marker) return;
    result.push({
      key: `${entry.id}:plain:${index}`,
      path: entry.path,
      text: line.slice(1),
      lineNumber: lineNumber++,
      kind,
    });
    remaining--;
  }
  return !remaining && result.length ? result : undefined;
}

function SingleSidePatch({ lines, focusKey }: { lines: SingleSideLine[]; focusKey?: string }) {
  const code = useMemo(() => lines.map((line) => line.text).join("\n"), [lines]);
  const language = toolCodeLanguage(lines[0]?.path ?? "", code);
  const tokens = useToolTokens(code, language);
  const focusedLine = focusKey ? lines.findIndex((line) => line.key === focusKey) : -1;
  const start = focusedLine >= 2000 ? Math.max(0, focusedLine - 1000) : 0;
  const end = Math.min(lines.length, start + 2000);
  return (
    <section
      className="diff-lightweight"
      data-lightweight-diff-preview
      data-lightweight-diff-highlight-language={language}
      data-lightweight-diff-highlighted={Boolean(tokens)}
      aria-label="文本变更"
    >
      <div className="tool-diff-lines">
        {lines.slice(start, end).map((line, index) => (
          <div className={`tool-diff-line ${line.kind}`} key={line.key}>
            <span className="tool-diff-number" aria-hidden="true">
              {line.lineNumber}
            </span>
            <code className="diff-lightweight-code" data-find-key={line.key}>
              {line.text && tokens?.[start + index]?.length
                ? tokens[start + index].map((token, tokenIndex) => (
                    <span key={tokenIndex} style={{ color: token.color }}>
                      {token.content}
                    </span>
                  ))
                : line.text || " "}
            </code>
          </div>
        ))}
      </div>
      {lines.length > 2000 && (
        <p>
          {start ? `大文件预览第 ${start + 1}–${end} 行` : "大文件预览前 2000 行"}；可打开文件查看完整内容。
        </p>
      )}
    </section>
  );
}

function PlainPatch({
  patch,
  id,
  focusKey,
  simple,
}: {
  patch: string;
  id: string;
  focusKey?: string;
  simple?: boolean;
}) {
  let old = 0,
    current = 0;
  const targets = patchFindTargets(id, "", patch);
  const lines = patch.split("\n");
  let targetIndex = 0;
  const keys = lines.map((line) =>
    /^[ +-]/.test(line) && !/^(---|\+\+\+) /.test(line) ? targets[targetIndex++]?.key : undefined,
  );
  const focusedLine = focusKey ? keys.indexOf(focusKey) : -1;
  const start = focusedLine >= 2000 ? Math.max(0, focusedLine - 1000) : 0;
  const end = Math.min(lines.length, start + 2000);
  return (
    <section className="diff-plain" aria-label="文本变更">
      {lines.map((line, i) => {
        const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (header) {
          old = Number(header[1]);
          current = Number(header[2]);
          if (i < start || i >= end) return null;
          return simple ? (
            <hr className="diff-hunk diff-hunk-simple" key={i} aria-label={line} />
          ) : (
            <div className="diff-hunk" key={i}>
              {line}
            </div>
          );
        }
        if (
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("Index:") ||
          /^=+$/.test(line) ||
          (simple &&
            /^(diff --git |index |(?:old|new) mode |(?:new|deleted) file mode |(?:rename|copy) (?:from|to) |similarity index )/.test(
              line,
            ))
        )
          return null;
        const kind = line[0],
          left = [" ", "-"].includes(kind) ? old++ : "",
          right = [" ", "+"].includes(kind) ? current++ : "";
        if (i < start || i >= end) return null;
        return (
          <div className={`diff-row ${kind === "+" ? "added" : kind === "-" ? "removed" : ""}`} key={i}>
            <span>{left}</span>
            <span>{right}</span>
            <code className="diff-line-code" data-find-key={keys[i]}>
              {[" ", "-", "+"].includes(kind) ? line.slice(1) : line}
            </code>
          </div>
        );
      })}
      {lines.length > 2000 && (
        <p>
          {start ? `大文件预览第 ${start + 1}–${end} 行` : "大文件预览前 2000 行"}；可打开文件查看完整内容。
        </p>
      )}
    </section>
  );
}
class PatchBoundary extends Component<
  { patch: string; id: string; focusKey?: string; simple?: boolean; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <PlainPatch
        patch={this.props.patch}
        id={this.props.id}
        focusKey={this.props.focusKey}
        simple={this.props.simple}
      />
    ) : (
      this.props.children
    );
  }
}
export function DiffView({
  entries,
  initialPath,
  loadPatch,
  openFile,
  findRequest,
  onFindStateChange,
  renderHeader,
  wrap = false,
}: {
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  entries: DiffEntry[];
  initialPath?: string;
  loadPatch: (id: string) => Promise<string>;
  openFile: (id: string) => void;
  renderHeader?: (path: string, openFile: () => void) => ReactNode;
  wrap?: boolean;
}) {
  const paths = [...new Set(entries.map((entry) => entry.path))];
  const preview = Boolean(renderHeader);
  const [selected, setSelected] = useState(initialPath ?? paths[0] ?? ""),
    [patches, setPatches] = useState<Record<string, string>>({}),
    [error, setError] = useState(""),
    [split, setSplit] = useState(false);
  const { theme } = useAppearance();
  const root = useRef<HTMLDivElement>(null);
  const [focusKey, setFocusKey] = useState<string>();
  const searching = Boolean(findRequest?.query.trim());
  const patchScope = searching ? undefined : selected;
  const findTargets = useMemo(
    () =>
      searching
        ? entries.flatMap((entry) => {
            const patch = entry.patch ?? patches[entry.id] ?? "";
            return (
              (preview && singleSidePatchLines(entry, patch)) || patchFindTargets(entry.id, entry.path, patch)
            );
          })
        : [],
    [entries, patches, searching, preview],
  );
  const navigateFind = useCallback((match: FindMatch, range?: Range) => {
    if (match.path) setSelected(match.path);
    setFocusKey(match.key);
    const element = range?.startContainer.parentElement;
    element?.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
  }, []);
  useTextFind({
    rootRef: root,
    request: findRequest,
    content: selected,
    scopeKey: "diff",
    targets: findTargets,
    highlightScope: "changes",
    onStateChange: onFindStateChange,
    onNavigate: navigateFind,
  });
  const rendered = useCallback(
    (node: HTMLElement) => node.dispatchEvent(new Event("zpi-diff-render", { bubbles: true })),
    [],
  );
  useEffect(() => {
    if (initialPath) setSelected(initialPath);
  }, [initialPath]);
  useEffect(() => {
    if (!paths.includes(selected))
      setSelected(initialPath && paths.includes(initialPath) ? initialPath : (paths[0] ?? ""));
  }, [entries, selected, initialPath]);
  useEffect(() => {
    let active = true;
    setError("");
    void Promise.allSettled(
      entries
        .filter(
          (entry) =>
            (patchScope === undefined || entry.path === patchScope) &&
            entry.patchAvailable &&
            entry.patch === undefined,
        )
        .map(async (entry) => [entry.id, await loadPatch(entry.id)] as const),
    ).then((values) => {
      if (!active) return;
      setPatches(
        Object.fromEntries(values.flatMap((value) => (value.status === "fulfilled" ? [value.value] : []))),
      );
      const failure = values.find((value) => value.status === "rejected");
      if (failure?.status === "rejected") setError(String(failure.reason));
    });
    return () => {
      active = false;
    };
  }, [entries, patchScope, loadPatch]);
  return (
    <div
      ref={root}
      className={`diff-layout${paths.length <= 1 ? " diff-single-file" : ""}${renderHeader ? " diff-preview" : ""}${wrap ? " diff-wrap" : ""}`}
    >
      {paths.length > 1 && (
        <nav aria-label="改动文件">
          {paths.map((path) => (
            <button
              type="button"
              className={path === selected ? "selected" : ""}
              key={path}
              onClick={() => setSelected(path)}
              title={path}
            >
              <FileCode2 size={15} />
              <span className="diff-file-name">
                <strong>{path.split("/").at(-1)}</strong>
                <small>{path.slice(0, path.lastIndexOf("/"))}</small>
              </span>
              <span className="diff-file-status">
                {entries.find((entry) => entry.path === path)?.status === "created" ? "A" : "M"}
              </span>
            </button>
          ))}
        </nav>
      )}
      <div className="diff-detail">
        {selected &&
          renderHeader?.(selected, () => {
            const entry = entries.find((entry) => entry.path === selected);
            if (entry) openFile(entry.id);
          })}
        <div className="diff-content">
          {!paths.length && <p className="pane-empty">暂无文件变更</p>}
          {error && <p role="alert">{error}</p>}
          {selected && !renderHeader && (
            <div className="diff-mode">
              <span title={selected}>{selected.split("/").at(-1)}</span>
              <button aria-pressed={!split} onClick={() => setSplit(false)}>
                统一
              </button>
              <button aria-pressed={split} onClick={() => setSplit(true)}>
                并排
              </button>
            </div>
          )}
          {entries
            .filter((entry) => entry.path === selected)
            .map((entry) => {
              const patch = entry.patch ?? patches[entry.id] ?? "",
                singleSide = renderHeader ? singleSidePatchLines(entry, patch) : undefined,
                large = patch.length > 180000 || patch.split("\n").length > 1200;
              return (
                <section className="diff-entry" key={entry.id} data-diff-id={entry.id}>
                  {!renderHeader && (
                    <div className="diff-heading">
                      <small>
                        {entry.area}
                        {entry.failed ? " · 部分修改失败" : ""}
                      </small>
                      <button type="button" onClick={() => openFile(entry.id)}>
                        打开文件
                      </button>
                    </div>
                  )}
                  {renderHeader && entry.failed && <p className="run-notice">部分修改失败</p>}
                  {entry.oldPath && (
                    <p>
                      {entry.oldPath} → {entry.path}
                    </p>
                  )}
                  {entry.reason && <p className="run-notice">{entry.reason}</p>}
                  {singleSide ? (
                    <SingleSidePatch lines={singleSide} focusKey={searching ? focusKey : undefined} />
                  ) : patch ? (
                    <PatchBoundary
                      key={patch}
                      patch={patch}
                      id={entry.id}
                      focusKey={searching ? focusKey : undefined}
                      simple={Boolean(renderHeader)}
                    >
                      {large ? (
                        <PlainPatch
                          patch={patch}
                          id={entry.id}
                          focusKey={searching ? focusKey : undefined}
                          simple={Boolean(renderHeader)}
                        />
                      ) : (
                        <PatchDiff
                          patch={patch}
                          options={{
                            diffStyle: !renderHeader && split ? "split" : "unified",
                            themeType: theme,
                            disableFileHeader: true,
                            overflow: wrap ? "wrap" : "scroll",
                            diffIndicators: "bars",
                            lineDiffType: "word-alt",
                            hunkSeparators: renderHeader ? "simple" : "line-info",
                            enableLineSelection: false,
                            expandUnchanged: searching,
                            unsafeCSS: findHighlightCSS,
                            onPostRender: rendered,
                          }}
                        />
                      )}
                    </PatchBoundary>
                  ) : entry.patchAvailable ? (
                    <p>加载变更…</p>
                  ) : null}
                </section>
              );
            })}
        </div>
      </div>
    </div>
  );
}
