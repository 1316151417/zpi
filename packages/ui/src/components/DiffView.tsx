import { PatchDiff } from "@pierre/diffs/react";
import { FileCode2 } from "lucide-react";
import { Component, type ReactNode, useEffect, useState } from "react";
import { useAppearance } from "../appearance.ts";
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
function PlainPatch({ patch }: { patch: string }) {
  let old = 0,
    current = 0;
  return (
    <section className="diff-plain" aria-label="文本变更">
      {patch
        .split("\n")
        .slice(0, 2000)
        .map((line, i) => {
          const header = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
          if (header) {
            old = Number(header[1]);
            current = Number(header[2]);
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
          return (
            <div className={`diff-row ${kind === "+" ? "added" : kind === "-" ? "removed" : ""}`} key={i}>
              <span>{left}</span>
              <span>{right}</span>
              <code>{[" ", "-", "+"].includes(kind) ? line.slice(1) : line}</code>
            </div>
          );
        })}
      {patch.split("\n").length > 2000 && <p>大文件预览前 2000 行；可打开文件查看完整内容。</p>}
    </section>
  );
}
class PatchBoundary extends Component<{ patch: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <PlainPatch patch={this.props.patch} /> : this.props.children;
  }
}
export function DiffView({
  entries,
  initialPath,
  loadPatch,
  openFile,
}: {
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
    void Promise.all(
      entries
        .filter((entry) => entry.path === selected && entry.patchAvailable)
        .map(async (entry) => [entry.id, await loadPatch(entry.id)] as const),
    )
      .then((values) => {
        if (active) setPatches(Object.fromEntries(values));
      })
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [entries, selected, loadPatch]);
  return (
    <div className="diff-layout">
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
              <section key={entry.id}>
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
                  <PatchBoundary key={patch} patch={patch}>
                    {large ? (
                      <PlainPatch patch={patch} />
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
