import * as Menu from "@radix-ui/react-dropdown-menu";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertCircle,
  Copy,
  Ellipsis,
  Files,
  FolderOpen,
  GitCommitVertical,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from "lucide-react";
import { type CSSProperties, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react";
import { ActionHint } from "zpi-ui";
import { fuzzyScore } from "zpi-ui/fuzzy-search";
import type { EditorInfo } from "../../shared/editors.ts";
import { paneTask } from "../pane-store.ts";
import { report } from "../store.ts";
import { unwrap } from "../unwrap.ts";
import { FileTreeRow, fileManagerLabel } from "./FileTreeRow.tsx";
import {
  areWorkspaceFilePathsEqual,
  buildWorkspaceDirectoryGitStatuses,
  filterWorkspaceFileTreeRows,
  getWorkspaceDirectoryGitStatuses,
  getWorkspaceFileAncestorDirectories,
  getWorkspaceFileDirectoryChildDepth,
  getWorkspaceFileGitStatus,
  isWorkspaceFilePathInside,
  type WorkspaceFileTreeRow,
} from "./model.ts";
import { useWorkspaceFileTreeStickyFolders } from "./sticky-folders.ts";
import { useWorkspaceFileTreeData } from "./use-tree-data.ts";

// The index is separate from the lazy directory cache, including during search refresh.
type SearchEntry = { path: string; name: string; absolutePath: string; type: "file" | "directory" };
export function WorkspaceFileTree({
  sessionId,
  workspacePath,
  workspaceName,
  activePreviewPath,
  onOpenPreview,
}: {
  sessionId: string;
  workspacePath: string;
  workspaceName: string;
  activePreviewPath?: string;
  onOpenPreview: (path: string) => void;
}) {
  const data = useWorkspaceFileTreeData({ workspacePath, sessionId });
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const [changedOnly, setChangedOnly] = useState(false);
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [index, setIndex] = useState<SearchEntry[]>([]);
  const [indexLoaded, setIndexLoaded] = useState(false);
  const [indexLoading, setIndexLoading] = useState(false);
  const [indexError, setIndexError] = useState<Error | null>(null);
  const [indexRevision, setIndexRevision] = useState(0);
  const searching = query.trim().length > 0;
  const scroll = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const pendingReveal = useRef<{ path: string; search: boolean } | null>(null);
  const [overflow, setOverflow] = useState(false);
  const [bottomMask, setBottomMask] = useState(false);
  const rootLoaded = data.loadedDirectoryPaths.has(workspacePath);
  const rootError = data.errorByDirectory.get(workspacePath);
  const lastRootError = useRef<Error | undefined>(undefined);
  useEffect(() => {
    if (rootLoaded && rootError && lastRootError.current !== rootError) report(rootError);
    lastRootError.current = rootError;
  }, [rootLoaded, rootError]);
  useEffect(() => {
    if (!data.gitStatusAvailable) setChangedOnly(false);
  }, [data.gitStatusAvailable]);
  useEffect(() => {
    let active = true;
    void window.zpi
      .getInstalledEditors()
      .then(unwrap)
      .then((editors) => {
        if (active) setEditors(editors);
      })
      .catch(report);
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!searching) return;
    let active = true;
    setIndexLoading(true);
    setIndexError(null);
    void window.zpi
      .listTaskFiles(sessionId, workspacePath)
      .then(unwrap)
      .then((entries) => {
        if (active) {
          setIndex(entries);
          setIndexLoaded(true);
        }
      })
      .catch((error) => {
        if (active) setIndexError(error instanceof Error ? error : new Error(String(error)));
      })
      .finally(() => {
        if (active) setIndexLoading(false);
      });
    return () => {
      active = false;
    };
  }, [searching, sessionId, workspacePath, indexRevision]);
  const directoryStatusesByPath = useMemo(
    () => buildWorkspaceDirectoryGitStatuses(data.gitStatusByPath),
    [data.gitStatusByPath],
  );
  const rows = useMemo(() => {
    if (!searching)
      return filterWorkspaceFileTreeRows({
        rows: data.rows,
        changedOnly,
        statusByPath: data.gitStatusByPath,
        directoryStatusesByPath,
      });
    const normalized = query.trim().toLowerCase();
    return index
      .map((entry) => ({
        entry,
        score: Math.min(
          fuzzyScore(entry.name, normalized),
          fuzzyScore(entry.path, normalized) + 25,
          fuzzyScore(entry.absolutePath, normalized) + 300,
        ),
      }))
      .filter(
        ({ entry, score }) =>
          Number.isFinite(score) &&
          (!changedOnly || getWorkspaceFileGitStatus(data.gitStatusByPath, entry.absolutePath)),
      )
      .sort((a, b) => a.score - b.score)
      .slice(0, 1000)
      .map(
        ({ entry }): WorkspaceFileTreeRow => ({
          path: entry.absolutePath,
          name: entry.path,
          type: entry.type,
          depth: 0,
          expanded: false,
          loaded: false,
          loading: false,
          error: null,
        }),
      );
  }, [searching, query, index, changedOnly, data.rows, data.gitStatusByPath, directoryStatusesByPath]);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 28,
    overscan: 12,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const sticky = useWorkspaceFileTreeStickyFolders({
    rows,
    virtualItems,
    scrollDirection: virtualizer.scrollDirection,
    scrollOffset: virtualizer.scrollOffset ?? 0,
    enabled: overflow && !searching,
  });
  useEffect(() => {
    if (!activePreviewPath || !isWorkspaceFilePathInside(workspacePath, activePreviewPath)) return;
    let disposed = false;
    const ancestors = getWorkspaceFileAncestorDirectories(workspacePath, activePreviewPath);
    pendingReveal.current = { path: activePreviewPath, search: false };
    setSelected(activePreviewPath);
    data.setExpandedPaths((paths) => new Set([...paths, ...ancestors]));
    void (async () => {
      for (const path of ancestors) {
        if (disposed) return;
        await data.loadDirectory(path, getWorkspaceFileDirectoryChildDepth(workspacePath, path));
      }
    })();
    return () => {
      disposed = true;
    };
  }, [activePreviewPath, workspacePath, data.loadDirectory, data.setExpandedPaths]);
  useEffect(() => {
    const reveal = pendingReveal.current;
    if (!reveal || (reveal.search && searching)) return;
    const i = rows.findIndex((row) => areWorkspaceFilePathsEqual(row.path, reveal.path));
    if (i >= 0) {
      virtualizer.scrollToIndex(i, { align: reveal.search ? "center" : "auto" });
      pendingReveal.current = null;
    }
  }, [rows, searching, virtualizer]);
  useEffect(() => {
    const element = scroll.current;
    if (!element) return;
    const update = () => {
      list.current?.style.setProperty("--file-tree-mask-offset", `${element.scrollTop}px`);
      const hasOverflow = element.scrollHeight > element.clientHeight + 1;
      setOverflow(hasOverflow);
      setBottomMask(hasOverflow && element.scrollTop + element.clientHeight < element.scrollHeight - 1);
    };
    const observer = new ResizeObserver(update);
    observer.observe(element);
    if (list.current) observer.observe(list.current);
    element.addEventListener("scroll", update, { passive: true });
    update();
    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", update);
    };
  }, [rows.length, rootLoaded, rootError]);
  const toggle = (row: WorkspaceFileTreeRow) => {
    if (searching) {
      const paths = [...getWorkspaceFileAncestorDirectories(workspacePath, row.path), row.path];
      pendingReveal.current = { path: row.path, search: true };
      setSelected(row.path);
      data.setExpandedPaths((current) => new Set([...current, ...paths]));
      setQuery("");
      void (async () => {
        for (const path of paths)
          await data.loadDirectory(path, getWorkspaceFileDirectoryChildDepth(workspacePath, path));
      })();
      return;
    }
    data.setExpandedPaths((current) => {
      const next = new Set(current);
      if (next.has(row.path)) {
        for (const path of row.compactedPaths ?? [row.path]) next.delete(path);
      } else next.add(row.path);
      return next;
    });
    if (!row.expanded)
      void data.loadDirectory(row.path, getWorkspaceFileDirectoryChildDepth(workspacePath, row.path));
  };
  const open = (row: WorkspaceFileTreeRow) => {
    if (row.type === "directory") toggle(row);
    else if (getWorkspaceFileGitStatus(data.gitStatusByPath, row.path) !== "deleted") onOpenPreview(row.path);
  };
  const keyDown = (event: KeyboardEvent<HTMLDivElement>, row: WorkspaceFileTreeRow) => {
    if (event.key === "Enter") {
      event.preventDefault();
      open(row);
    }
    if (event.key === "ArrowRight" && row.type === "directory" && (!row.expanded || searching)) {
      event.preventDefault();
      toggle(row);
    }
    if (event.key === "ArrowLeft" && row.type === "directory" && row.expanded) {
      event.preventDefault();
      toggle(row);
    }
  };
  const renderRow = (row: WorkspaceFileTreeRow, style?: CSSProperties, stickyIndex?: number) => (
    <FileTreeRow
      key={row.path}
      row={row}
      selected={selected === row.path}
      gitStatus={
        getWorkspaceFileGitStatus(data.gitStatusByPath, row.path) ??
        (data.ignoredPathSet.has(row.path) ? "ignored" : null)
      }
      directoryStatuses={
        row.type === "directory" ? getWorkspaceDirectoryGitStatuses(directoryStatusesByPath, row.path) : []
      }
      sessionId={sessionId}
      workspacePath={workspacePath}
      editors={editors}
      style={style}
      staticRow={stickyIndex !== undefined}
      onSelect={setSelected}
      onOpen={open}
      onKeyDown={keyDown}
      onToggle={(row) => {
        toggle(row);
        if (stickyIndex !== undefined && row.expanded)
          requestAnimationFrame(() => virtualizer.scrollToIndex(stickyIndex, { align: "start" }));
      }}
    />
  );
  const refresh = () => {
    void data.refreshLoadedDirectories();
    if (searching) setIndexRevision((n) => n + 1);
  };
  const loading = !rootLoaded || (searching && indexLoading && !indexLoaded);
  const error = searching ? indexError : !rootLoaded ? rootError : null;
  const refreshing =
    data.loadingDirectoryPaths.has(workspacePath) || data.refreshingLoadedDirectories || indexLoading;
  const hiddenHeight = sticky.length * 28;
  const maskImage = `linear-gradient(to bottom, transparent 0 ${hiddenHeight}px, black ${hiddenHeight}px)`;
  return (
    <section className="workspace-file-tree" aria-label="文件目录">
      <div className="file-tree-search">
        <Search size={14} aria-hidden="true" />
        <input
          aria-label="搜索文件"
          placeholder="搜索文件..."
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query.length > 0 && (
          <button type="button" aria-label="清空文件搜索" title="清空文件搜索" onClick={() => setQuery("")}>
            <X size={12} />
          </button>
        )}
      </div>
      <div className="file-tree-toolbar">
        <div className="file-tree-title">
          <h3 title={workspacePath}>{workspaceName}</h3>
        </div>
        <Menu.Root>
          <Menu.Trigger asChild>
            <button className="file-tree-icon-button" type="button" aria-label="更多" title="更多">
              <Ellipsis size={14} />
            </button>
          </Menu.Trigger>
          <Menu.Portal>
            <Menu.Content className="selection-menu file-tree-more" align="end" sideOffset={2}>
              <Menu.Item
                className="menu-item"
                onSelect={() =>
                  paneTask(window.zpi.fileAction(sessionId, workspacePath, "reveal").then(unwrap))
                }
              >
                <FolderOpen size={16} />
                {fileManagerLabel}
              </Menu.Item>
              <Menu.Item
                className="menu-item"
                onSelect={() =>
                  paneTask(window.zpi.fileAction(sessionId, workspacePath, "copy-absolute").then(unwrap))
                }
              >
                <Copy size={16} />
                复制路径
              </Menu.Item>
            </Menu.Content>
          </Menu.Portal>
        </Menu.Root>
        {data.gitStatusAvailable && (
          <ActionHint label={changedOnly ? "显示全部文件" : "仅显示变更文件"} appearance="control">
            <button
              className="file-tree-icon-button"
              type="button"
              aria-pressed={changedOnly}
              aria-label={changedOnly ? "显示全部文件" : "仅显示变更文件"}
              onClick={() => setChangedOnly((value) => !value)}
            >
              <GitCommitVertical size={14} />
            </button>
          </ActionHint>
        )}
        <ActionHint label="刷新文件树" appearance="control">
          <button
            className="file-tree-icon-button"
            type="button"
            aria-label="刷新文件树"
            disabled={data.refreshingLoadedDirectories}
            onClick={refresh}
          >
            <RefreshCw size={14} className={refreshing ? "file-tree-loading" : ""} />
          </button>
        </ActionHint>
      </div>
      <div ref={scroll} className={`file-tree-scroll${bottomMask ? " bottom-mask" : ""}`}>
        {error ? (
          <div className="file-tree-notice" role="alert">
            <AlertCircle size={16} />
            <span>读取目录失败</span>
            <p>{error.message}</p>
          </div>
        ) : loading ? (
          <div className="file-tree-notice" role="status">
            <LoaderCircle size={16} className="file-tree-loading" />
            <span>加载中...</span>
          </div>
        ) : rows.length === 0 ? (
          <div className="file-tree-notice">
            <Files size={16} />
            <span>{searching || changedOnly ? "没有匹配的文件。" : "当前目录为空。"}</span>
          </div>
        ) : (
          <>
            {sticky.length > 0 && (
              <div className="file-tree-sticky">
                <div>{sticky.map(({ row, index }) => renderRow(row, undefined, index))}</div>
              </div>
            )}
            <div
              ref={list}
              className="file-tree-list"
              role="tree"
              aria-label={workspaceName}
              style={{
                height: virtualizer.getTotalSize(),
                ...(hiddenHeight
                  ? {
                      maskImage,
                      WebkitMaskImage: maskImage,
                      maskPosition: "0 var(--file-tree-mask-offset)",
                      WebkitMaskPosition: "0 var(--file-tree-mask-offset)",
                      maskSize: "100% calc(100% - var(--file-tree-mask-offset))",
                      WebkitMaskSize: "100% calc(100% - var(--file-tree-mask-offset))",
                      maskRepeat: "no-repeat",
                      WebkitMaskRepeat: "no-repeat",
                    }
                  : {}),
              }}
            >
              {virtualItems.map(
                (item) =>
                  rows[item.index] &&
                  renderRow(rows[item.index], {
                    height: item.size,
                    transform: `translateY(${item.start}px)`,
                  }),
              )}
            </div>
          </>
        )}
      </div>
    </section>
  );
}
