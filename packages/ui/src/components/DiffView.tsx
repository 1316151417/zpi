import { PatchDiff } from "@pierre/diffs/react";
import { FileCode2 } from "lucide-react";
import { Component, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppearance } from "../appearance.ts";
import type { FindMatch, FindRequest, FindState } from "../find.ts";
import { patchFindTargets } from "../patch-find.ts";
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
function PlainPatch({ patch, id, focusKey }: { patch: string; id: string; focusKey?: string }) {
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
          return (
            <div className="diff-hunk" key={i}>
              {line}
            </div>
          );
        }
        if (
          line.startsWith("--- ") ||
          line.startsWith("+++ ") ||
          line.startsWith("Index:") ||
          /^=+$/.test(line)
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
            <code data-find-key={keys[i]}>{[" ", "-", "+"].includes(kind) ? line.slice(1) : line}</code>
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
  { patch: string; id: string; focusKey?: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? (
      <PlainPatch patch={this.props.patch} id={this.props.id} focusKey={this.props.focusKey} />
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
}: {
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
  entries: DiffEntry[];
  initialPath?: string;
  loadPatch: (id: string) => Promise<string>;
  openFile: (id: string) => void;
}) {
  const paths = [...new Set(entries.map((entry) => entry.path))];
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
        ? entries.flatMap((entry) =>
            patchFindTargets(entry.id, entry.path, entry.patch ?? patches[entry.id] ?? ""),
          )
        : [],
    [entries, patches, searching],
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
    <div ref={root} className="diff-layout">
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
        {!paths.length && <p className="pane-empty">暂无文件变更</p>}
      </nav>
      <div className="diff-detail">
        {error && <p role="alert">{error}</p>}
        {selected && (
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
              large = patch.length > 180000 || patch.split("\n").length > 1200;
            return (
              <section key={entry.id} data-diff-id={entry.id}>
                <div className="diff-heading">
                  <small>
                    {entry.area}
                    {entry.failed ? " · 部分修改失败" : ""}
                  </small>
                  <button type="button" onClick={() => openFile(entry.id)}>
                    打开文件
                  </button>
                </div>
                {entry.oldPath && (
                  <p>
                    {entry.oldPath} → {entry.path}
                  </p>
                )}
                {entry.reason && <p className="run-notice">{entry.reason}</p>}
                {patch ? (
                  <PatchBoundary
                    key={patch}
                    patch={patch}
                    id={entry.id}
                    focusKey={searching ? focusKey : undefined}
                  >
                    {large ? (
                      <PlainPatch patch={patch} id={entry.id} focusKey={searching ? focusKey : undefined} />
                    ) : (
                      <PatchDiff
                        patch={patch}
                        options={{
                          diffStyle: split ? "split" : "unified",
                          themeType: theme,
                          disableFileHeader: true,
                          overflow: "scroll",
                          diffIndicators: "bars",
                          lineDiffType: "word",
                          hunkSeparators: "line-info",
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
  );
}
