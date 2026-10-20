import * as Context from "@radix-ui/react-context-menu";
import { AlertCircle, ChevronRight, LoaderCircle } from "lucide-react";
import { type CSSProperties, Fragment, type KeyboardEvent } from "react";
import { buildMentionMarkdown } from "zpi-coding-agent/input";
import { ActionHint, FileIcon } from "zpi-ui";
import type { EditorInfo } from "../../shared/editors.ts";
import { openBrowser, paneTask } from "../pane-store.ts";
import { drafts, focusComposer, report } from "../store.ts";
import { unwrap } from "../unwrap.ts";
import { getWorkspaceFileTreeHierarchyGuideStyle } from "./hierarchy-guides.ts";
import {
  getWorkspaceFileRelativePath,
  type WorkspaceFileGitStatus,
  type WorkspaceFileTreeRow,
} from "./model.ts";
import { useWorkspaceFileTreeRowDragState } from "./use-row-drag.ts";

export const fileManagerLabel = /mac/i.test(navigator.userAgent)
  ? "在 Finder 中打开"
  : /windows/i.test(navigator.userAgent)
    ? "在文件资源管理器中打开"
    : "在文件管理器中打开";
const letters = { modified: "M", added: "A", deleted: "D", renamed: "R", untracked: "U", ignored: "" };
const labels = {
  modified: "修改",
  added: "新增",
  deleted: "删除",
  renamed: "重命名",
  untracked: "未跟踪",
  ignored: "已忽略",
};
export function addFileToChat(sessionId: string, path: string, name: string, directory: boolean) {
  const draft = drafts.get(sessionId);
  if (!draft) return;
  drafts.set(sessionId, {
    ...draft,
    text: `${draft.text}${draft.text && !/\s$/.test(draft.text) ? " " : ""}${buildMentionMarkdown(name, path + (directory ? "/" : ""))} `,
  });
  focusComposer(sessionId);
}
export function FileTreeRow({
  row,
  selected,
  gitStatus,
  directoryStatuses,
  sessionId,
  workspacePath,
  editors,
  style,
  staticRow,
  onSelect,
  onToggle,
  onOpen,
  onKeyDown,
}: {
  row: WorkspaceFileTreeRow;
  selected: boolean;
  gitStatus: WorkspaceFileGitStatus | null;
  directoryStatuses: WorkspaceFileGitStatus[];
  sessionId: string;
  workspacePath: string;
  editors: EditorInfo[];
  style?: CSSProperties;
  staticRow?: boolean;
  onSelect: (path: string) => void;
  onToggle: (row: WorkspaceFileTreeRow) => void;
  onOpen: (row: WorkspaceFileTreeRow) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => void;
}) {
  const directory = row.type === "directory";
  const deleted = !directory && gitStatus === "deleted";
  const status = gitStatus ?? directoryStatuses[0];
  const relativePath = getWorkspaceFileRelativePath(workspacePath, row.path);
  const { isDragging, setIsDragging } = useWorkspaceFileTreeRowDragState();
  const guides = getWorkspaceFileTreeHierarchyGuideStyle(row.depth);
  const action = (action: "reveal" | "copy-absolute" | "copy-relative") =>
    paneTask(window.zpi.fileAction(sessionId, row.path, action).then(unwrap));
  const primary = () => {
    if (!deleted) {
      if (directory) onToggle(row);
      else onOpen(row);
    }
  };
  return (
    <div
      className={`file-tree-row-slot${staticRow ? " static" : ""}`}
      style={{ ...style, "--workspace-file-tree-depth": row.depth } as CSSProperties}
    >
      <Context.Root>
        <Context.Trigger asChild>
          <div
            role="treeitem"
            aria-expanded={directory ? row.expanded : undefined}
            aria-selected={selected}
            tabIndex={0}
            data-path={row.path}
            data-git-status={gitStatus ?? undefined}
            className={`file-tree-row${selected ? " selected" : ""}${deleted ? " deleted" : ""}`}
            title={relativePath}
            draggable={!deleted}
            onClick={(event) => {
              onSelect(row.path);
              if (event.detail <= 1) primary();
            }}
            onContextMenu={() => onSelect(row.path)}
            onKeyDown={(event) => {
              if (deleted && event.key === "Enter") {
                event.preventDefault();
                onSelect(row.path);
              } else onKeyDown(event, row);
            }}
            onDragStart={(event) => {
              if (deleted) {
                event.preventDefault();
                return;
              }
              event.dataTransfer.effectAllowed = "copy";
              event.dataTransfer.setData(
                "application/x-zpi-workspace-file",
                JSON.stringify({ path: row.path, name: row.name, type: row.type, workspacePath }),
              );
              event.dataTransfer.setData(
                "text/plain",
                buildMentionMarkdown(row.name, row.path + (directory ? "/" : "")),
              );
              setIsDragging(true);
            }}
            onDragEnd={() => setIsDragging(false)}
          >
            {guides && !isDragging && (
              <span
                aria-hidden="true"
                className="file-tree-guides"
                data-workspace-file-tree-hierarchy-guides={row.depth}
                style={guides}
              />
            )}
            {directory && (
              <span className="file-tree-chevron">
                <ChevronRight size={12} className={row.expanded ? "expanded" : ""} aria-hidden="true" />
              </span>
            )}
            <span className={`file-tree-name${status ? ` git-${status}` : ""}`}>
              {!directory && <FileIcon path={row.path} size={16} />}
              <span>
                {row.name.split("/").map((name, i) => (
                  <Fragment key={`${i}:${name}`}>
                    {i > 0 && <span className="file-tree-slash">/</span>}
                    <span>{name}</span>
                  </Fragment>
                ))}
              </span>
            </span>
            {gitStatus && letters[gitStatus] && (
              <ActionHint label={labels[gitStatus]} appearance="control" side="right" sideOffset={4}>
                <span
                  role="img"
                  className={`file-tree-status git-${gitStatus}`}
                  aria-label={labels[gitStatus]}
                >
                  {letters[gitStatus]}
                </span>
              </ActionHint>
            )}
            {!row.loading && directoryStatuses.length > 0 && (
              <ActionHint
                label={directoryStatuses.map((s) => labels[s]).join(", ")}
                appearance="control"
                side="right"
                sideOffset={4}
              >
                <span role="img" className={`file-tree-dot git-${directoryStatuses[0]}`} aria-label="●" />
              </ActionHint>
            )}
            {row.loading ? (
              <LoaderCircle size={12} className="file-tree-loading" />
            ) : row.error ? (
              <span className="file-tree-error" title={row.error.message}>
                <AlertCircle size={12} />
              </span>
            ) : null}
          </div>
        </Context.Trigger>
        <Context.Portal>
          <Context.Content
            className="selection-menu file-tree-context"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <Context.Item className="menu-item" disabled={deleted} onSelect={primary}>
              打开
            </Context.Item>
            <Context.Sub>
              <Context.SubTrigger className="menu-item" disabled={deleted || editors.length === 0}>
                打开方式
                <ChevronRight size={14} />
              </Context.SubTrigger>
              <Context.Portal>
                <Context.SubContent className="selection-menu file-tree-context">
                  {editors.map((editor) => (
                    <Context.Item
                      key={editor.id}
                      className="menu-item"
                      onSelect={() =>
                        paneTask(window.zpi.openInEditor(sessionId, row.path, editor.id).then(unwrap))
                      }
                    >
                      {editor.name}
                    </Context.Item>
                  ))}
                </Context.SubContent>
              </Context.Portal>
            </Context.Sub>
            {!deleted && !directory && /\.(html|htm)$/i.test(row.path) && (
              <Context.Item
                className="menu-item"
                onSelect={() =>
                  paneTask(
                    openBrowser(`file://${row.path.split("/").map(encodeURIComponent).join("/")}`, sessionId),
                  )
                }
              >
                用内置浏览器打开
              </Context.Item>
            )}
            <Context.Separator className="preview-menu-separator" />
            <Context.Item className="menu-item" disabled={deleted} onSelect={() => action("reveal")}>
              {fileManagerLabel}
            </Context.Item>
            <Context.Item className="menu-item" onSelect={() => action("copy-absolute")}>
              复制绝对路径
            </Context.Item>
            <Context.Item className="menu-item" onSelect={() => action("copy-relative")}>
              复制相对路径
            </Context.Item>
            <Context.Separator className="preview-menu-separator" />
            <Context.Item
              className="menu-item"
              onSelect={() => {
                try {
                  addFileToChat(sessionId, row.path, row.name, directory);
                } catch (error) {
                  report(error);
                }
              }}
            >
              添加到聊天
            </Context.Item>
          </Context.Content>
        </Context.Portal>
      </Context.Root>
    </div>
  );
}
