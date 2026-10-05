import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronDown, ChevronRight, Copy, TriangleAlert } from "lucide-react";
import { useState } from "react";
import type { FileAction, RunView } from "../types.ts";
import { FileIcon } from "./Reference.tsx";

function OpenFileButton({
  path,
  name,
  onAction,
  onError,
}: {
  path: string;
  name: string;
  onAction?: (path: string, action: FileAction) => Promise<void>;
  onError: (error: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const perform = async (action: FileAction) => {
    if (!onAction || busy) return;
    setBusy(true);
    onError("");
    try {
      await onAction(path, action);
    } catch (error) {
      onError(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Menu.Root>
      <div className="changed-file-open">
        <button
          type="button"
          className="changed-file-open-default"
          disabled={!onAction || busy}
          aria-label={`打开 ${name}`}
          title="使用默认应用程序打开"
          onClick={() => void perform("open")}
        >
          打开
        </button>
        <Menu.Trigger
          className="changed-file-open-menu"
          disabled={!onAction || busy}
          aria-label={`打开菜单 ${name}`}
          title="选择打开方式"
        >
          <ChevronDown size={14} aria-hidden="true" />
        </Menu.Trigger>
      </div>
      <Menu.Portal>
        <Menu.Content className="selection-menu changed-file-menu" align="end" side="top" sideOffset={2}>
          <Menu.Item className="menu-item" onSelect={() => void perform("reveal")}>
            <img
              src={new URL("./file-actions/finder.png", document.baseURI).href}
              width={16}
              height={16}
              alt=""
            />
            <span>Finder</span>
          </Menu.Item>
          <Menu.Separator className="changed-file-menu-separator" />
          <Menu.Item className="menu-item" onSelect={() => void perform("copy-absolute")}>
            <Copy size={16} aria-hidden="true" />
            <span>复制绝对路径</span>
          </Menu.Item>
          <Menu.Item className="menu-item" onSelect={() => void perform("copy-relative")}>
            <Copy size={16} aria-hidden="true" />
            <span>复制相对路径</span>
          </Menu.Item>
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}

export function ChangedFiles({
  run,
  cwd,
  onChanges,
  onFileAction,
}: {
  run: RunView;
  cwd?: string;
  onChanges?: (runId: string, path?: string) => void;
  onFileAction?: (path: string, action: FileAction) => Promise<void>;
}) {
  const [error, setError] = useState("");
  const files = new Map<
    string,
    { additions: number; deletions: number; known: boolean; failed: boolean; edits: number }
  >();
  for (const block of run.orderedBlocks) {
    if (block.type !== "tool" || !block.fileChange) continue;
    const change = block.fileChange;
    const file = files.get(change.path) ?? {
      additions: 0,
      deletions: 0,
      known: true,
      failed: false,
      edits: 0,
    };
    file.additions += change.additions ?? 0;
    file.deletions += change.deletions ?? 0;
    file.known &&= change.additions !== undefined && change.deletions !== undefined;
    file.failed ||= Boolean(change.failed);
    file.edits++;
    files.set(change.path, file);
  }
  if (!files.size) return null;
  const summaries = Array.from(files.values());
  const known = summaries.every((file) => file.known);
  const additions = summaries.reduce((sum, file) => sum + file.additions, 0);
  const deletions = summaries.reduce((sum, file) => sum + file.deletions, 0);
  const root = cwd ? `${cwd.replace(/\/$/, "")}/` : undefined;
  return (
    <details className="changed-files">
      <summary className="changed-files-summary">
        <ChevronRight size={14} aria-hidden="true" className="changed-files-chevron" />
        <span className="changed-files-heading">
          <strong>{files.size} 个文件已更改</strong>
          {summaries.some((file) => file.failed) && (
            <span className="changed-files-warning" role="img" aria-label="部分修改失败" title="部分修改失败">
              <TriangleAlert size={14} aria-hidden="true" />
            </span>
          )}
        </span>
        <span className="changed-files-totals" title="工具修改的累计行数">
          {known ? (
            <>
              <span className="diff-added">+{additions}</span>
              <span className="diff-removed">-{deletions}</span>
            </>
          ) : (
            <span className="changed-file-note">行数未完整统计</span>
          )}
        </span>
      </summary>
      <ul className="changed-files-list">
        {Array.from(files, ([path, file]) => {
          const displayPath = root && path.startsWith(root) ? path.slice(root.length) : path;
          const name = displayPath.split("/").at(-1) ?? displayPath;
          const directory = displayPath.slice(0, -name.length);
          const review = () => onChanges?.(run.runId, path);
          return (
            <li
              className="changed-file-row"
              key={path}
              title={`${path}${file.edits > 1 ? "\n多次工具修改的累计行数" : ""}`}
            >
              <button
                type="button"
                className="changed-file-card"
                onClick={review}
                disabled={!onChanges || !file.known}
                aria-label={`查看修改 ${name}`}
              >
                <span className="changed-file-info">
                  <FileIcon path={path} size={16} />
                  <strong>{name}</strong>
                  {directory && <span className="changed-file-directory">{directory}</span>}
                </span>
                <span className="changed-file-counts">
                  {file.known ? (
                    <>
                      {file.additions > 0 && <span className="diff-added">+{file.additions}</span>}
                      {file.deletions > 0 && <span className="diff-removed">-{file.deletions}</span>}
                    </>
                  ) : (
                    <span className="changed-file-note">无法统计行数</span>
                  )}
                  {file.failed && <span className="changed-file-note">部分修改失败</span>}
                </span>
              </button>
              <span className="changed-file-actions">
                <button
                  type="button"
                  className="changed-file-review"
                  aria-label={`审查 ${name}`}
                  title="审查"
                  disabled={!onChanges || !file.known}
                  onClick={review}
                >
                  审查
                </button>
                <OpenFileButton path={path} name={name} onAction={onFileAction} onError={setError} />
              </span>
            </li>
          );
        })}
      </ul>
      {error && (
        <p className="changed-files-error" role="alert">
          {error}
        </p>
      )}
    </details>
  );
}
