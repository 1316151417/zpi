// UI adapted from ZCode GitPane / GitPaneChangeCard (Apache-2.0).
import * as Context from "@radix-ui/react-context-menu";
import * as Select from "@radix-ui/react-select";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronDown, ChevronUp, Copy, FileText, FolderOpen, ListTree, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  FileIcon,
  type FindRequest,
  type FindState,
  type ReviewDiffData,
  ReviewDiffViewer,
  reviewFindTargets,
  useTextFind,
} from "zpi-ui";
import type { DiffItem } from "../shared/bridge.ts";
import { type ReviewSnapshot, type ReviewSource, reviewPatchStats, reviewSources } from "../shared/review.ts";
import { openFileManager, paneTask } from "./pane-store.ts";
import { report } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { useWorkspace } from "./use-workspace.ts";
import { userErrorMessage } from "./user-error.ts";
import { fileManagerLabel } from "./workspace-file-tree/FileTreeRow.tsx";
import { getWorkspaceFileRelativePath } from "./workspace-file-tree/model.ts";
import "./review-pane.css";

export function ReviewPane({
  sessionId,
  visible,
  source,
  onSourceChange,
  findRequest,
  onFindStateChange,
}: {
  sessionId: string;
  visible: boolean;
  source: ReviewSource;
  onSourceChange: (source: ReviewSource) => void;
  findRequest?: FindRequest;
  onFindStateChange?: (state: FindState) => void;
}) {
  const workspace = useWorkspace(sessionId);
  const scope = JSON.stringify([sessionId, workspace?.cwd, source]);
  const [revision, setRevision] = useState(0);
  const [result, setResult] = useState<{
    scope: string;
    snapshot?: ReviewSnapshot;
    loading: boolean;
    error?: string;
  }>();
  const current = result?.scope === scope ? result : undefined;
  const loading = !current || current.loading;
  useEffect(() => {
    if (!visible) return;
    let active = true;
    setResult((previous) => ({
      ...(previous?.scope === scope ? previous : { scope }),
      loading: true,
      error: undefined,
    }));
    void window.zpi
      .getReview(sessionId, source)
      .then(unwrap)
      .then((snapshot) => {
        if (active) setResult({ scope, snapshot, loading: false });
      })
      .catch((error) => {
        if (active) setResult({ scope, error: userErrorMessage(error), loading: false });
      });
    return () => {
      active = false;
    };
  }, [scope, sessionId, source, visible, revision]);
  useEffect(() => {
    if (!visible) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setRevision((value) => value + 1), 200);
    };
    const off = window.zpi.onEvent((event) => {
      if (event.sessionId === sessionId && ["settled", "tool_end"].includes(event.event.type)) refresh();
    });
    window.addEventListener("focus", refresh);
    return () => {
      off();
      clearTimeout(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [sessionId, visible]);
  const snapshot = current?.snapshot;
  const watchSignature = JSON.stringify(snapshot?.watchPaths ?? []);
  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const registrations: { id: string; dispose: () => void }[] = [];
    for (const path of JSON.parse(watchSignature) as string[]) {
      void window.zpi
        .watchWorkspaceDirectory(sessionId, path, undefined, true)
        .then(unwrap)
        .then(({ id }) => {
          if (!active) {
            void window.zpi.unwatchWorkspaceDirectory(id);
            return;
          }
          const dispose = window.zpi.onWorkspaceDirectoryChange(id, () => {
            // ZCode useGitAutoRefresh：批量写入完成后 60 秒防抖，避免反复扫描整个仓库。
            clearTimeout(timer);
            timer = setTimeout(() => setRevision((value) => value + 1), 60_000);
          });
          registrations.push({ id, dispose });
        })
        .catch(report);
    }
    return () => {
      active = false;
      clearTimeout(timer);
      for (const { id, dispose } of registrations) {
        dispose();
        void window.zpi.unwatchWorkspaceDirectory(id).then(unwrap).catch(report);
      }
    };
  }, [watchSignature, sessionId, visible]);
  const entries = snapshot?.entries ?? [];
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState<{ scope: string; path: string | null }>();
  const expandedPath = expanded?.scope === scope ? expanded.path : null;
  const [loaded, setLoaded] = useState<{
    snapshot: ReviewSnapshot;
    values: Record<string, ReviewDiffData>;
  }>();
  const diffs = loaded?.snapshot === snapshot ? (loaded?.values ?? {}) : {};
  const requests = useRef<{
    snapshot: ReviewSnapshot | undefined;
    jobs: Map<string, Promise<ReviewDiffData>>;
  }>({ snapshot: undefined, jobs: new Map() });
  if (requests.current.snapshot !== snapshot) requests.current = { snapshot, jobs: new Map() };
  const load = useCallback(
    (entry: DiffItem) => {
      if (!snapshot) return Promise.resolve();
      const holder = requests.current;
      const existing = holder.jobs.get(entry.id);
      if (existing) return existing;
      const job = window.zpi
        .readReviewDiff(sessionId, source, entry.path, snapshot.runId)
        .then(unwrap)
        .catch(
          (error): ReviewDiffData => ({
            path: entry.path,
            availability: "unavailable",
            patch: null,
            beforeContent: null,
            afterContent: null,
            summary: userErrorMessage(error),
          }),
        )
        .then((diff) => {
          if (requests.current === holder)
            setLoaded((current) => ({
              snapshot,
              values: { ...(current?.snapshot === snapshot ? current.values : {}), [entry.id]: diff },
            }));
          return diff;
        });
      holder.jobs.set(entry.id, job);
      return job;
    },
    [snapshot, sessionId, source],
  );
  useEffect(() => {
    const entry = entries.find((entry) => entry.path === expandedPath);
    if (entry) void load(entry);
    else if (expandedPath) setExpanded({ scope, path: null });
  }, [entries, expandedPath, load, scope]);
  const searching = Boolean(visible && findRequest?.query.trim());
  useEffect(() => {
    if (!searching) return;
    let active = true;
    void (async () => {
      for (let index = 0; active && index < entries.length; index += 4)
        await Promise.all(entries.slice(index, index + 4).map(load));
    })();
    return () => {
      active = false;
    };
  }, [searching, entries, load]);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroll.current,
    getItemKey: (index) => entries[index].id,
    estimateSize: () => 32,
    overscan: 14,
  });
  useEffect(() => {
    virtualizer.measure();
  }, [virtualizer, expandedPath, scope]);
  const targets = useMemo(
    () =>
      searching
        ? entries.flatMap((entry) => (diffs[entry.id] ? reviewFindTargets(entry.id, diffs[entry.id]) : []))
        : [],
    [searching, entries, diffs],
  );
  const navigate = useCallback(
    (match: { path?: string }, range?: Range) => {
      if (!match.path) return;
      setExpanded({ scope, path: match.path });
      const index = entries.findIndex((entry) => entry.path === match.path);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
      range?.startContainer.parentElement?.scrollIntoView({ block: "center", inline: "nearest" });
    },
    [scope, entries, virtualizer],
  );
  useTextFind({
    rootRef: root,
    request: visible ? findRequest : undefined,
    content: diffs,
    scopeKey: scope,
    targets,
    highlightScope: "changes",
    onStateChange: onFindStateChange,
    onNavigate: navigate,
  });
  const row = useCallback(
    (entry: DiffItem, expanded: boolean, toggle: () => void) => {
      const path = getWorkspaceFileRelativePath(workspace?.cwd ?? "", entry.path);
      const slash = path.lastIndexOf("/");
      const stats = reviewPatchStats(entry.patch);
      const added = entry.added ?? stats.added;
      const removed = entry.removed ?? stats.removed;
      const action = (action: "reveal" | "copy-absolute" | "copy-relative") => {
        void window.zpi.fileAction(sessionId, entry.path, action).then(unwrap).catch(report);
      };
      return (
        <Context.Root>
          <Context.Trigger asChild>
            <button type="button" className="review-file-row" aria-expanded={expanded} onClick={toggle}>
              <span className="review-file-label">
                <FileIcon path={path} size={16} />
                <span className="review-file-name">{path.slice(slash + 1)}</span>
                {slash >= 0 && <span className="review-file-directory">{path.slice(0, slash)}</span>}
              </span>
              <span className="review-file-stats">
                <span>+{added}</span>
                <span>-{removed}</span>
              </span>
              <ChevronDown size={16} className="review-file-chevron" />
            </button>
          </Context.Trigger>
          <Context.Portal>
            <Context.Content className="parity-menu review-context-menu">
              <Context.Item
                className="parity-menu-item"
                disabled={entry.status === "deleted"}
                onSelect={() => action("reveal")}
              >
                <FolderOpen size={16} />
                {fileManagerLabel}
              </Context.Item>
              <Context.Item className="parity-menu-item" onSelect={() => action("copy-absolute")}>
                <Copy size={16} />
                复制绝对路径
              </Context.Item>
              <Context.Item className="parity-menu-item" onSelect={() => action("copy-relative")}>
                <Copy size={16} />
                复制相对路径
              </Context.Item>
              <Context.Separator className="parity-menu-separator" />
              <Context.Item
                className="parity-menu-item"
                onSelect={() => paneTask(openFileManager(sessionId, entry.path))}
              >
                <ListTree size={16} />
                在文件树中显示
              </Context.Item>
            </Context.Content>
          </Context.Portal>
        </Context.Root>
      );
    },
    [sessionId, workspace?.cwd],
  );
  const empty =
    source === "last-turn"
      ? ["当前任务还没有上一轮文件改动", "当 agent 产生文件写入后，这里会优先复用现有 task 快照做只读审阅。"]
      : loading
        ? ["加载中...", "正在读取当前工作区的 Git 状态和文件改动。"]
        : current?.error
          ? ["无法加载 Git 改动", `Git 返回错误：${current.error}`]
          : snapshot?.isGitAvailable === false
            ? ["当前环境没有可用的 Git", "请先安装 Git，或确认当前运行环境里可以执行 git 命令。"]
            : snapshot && !snapshot.isRepository
              ? [
                  "当前 workspace 不在 Git 仓库中",
                  "打开一个 Git 仓库目录后，这里会展示当前 workspace 作用域内的改动。",
                ]
              : [
                  "当前来源下没有可展示的改动",
                  "可以切换其它来源，或等当前 workspace 产生新的 Git 改动后再查看。",
                ];
  return (
    <section ref={root} className="review-pane" aria-label="审查">
      <div className="review-toolbar">
        <Select.Root value={source} onValueChange={(value) => onSourceChange(value as ReviewSource)}>
          <Select.Trigger className="review-source" aria-label="审查来源">
            <Select.Value />
            <Select.Icon asChild>
              <ChevronDown size={16} />
            </Select.Icon>
          </Select.Trigger>
          <Select.Portal>
            <Select.Content className="review-source-menu" align="start">
              <Select.ScrollUpButton className="review-source-scroll">
                <ChevronUp size={16} />
              </Select.ScrollUpButton>
              <Select.Viewport className="review-source-options">
                {Object.entries(reviewSources).map(([id, label]) => (
                  <Select.Item className="review-source-option" value={id} key={id}>
                    <Select.ItemText>{label}</Select.ItemText>
                    <Select.ItemIndicator>
                      <Check size={16} />
                    </Select.ItemIndicator>
                  </Select.Item>
                ))}
              </Select.Viewport>
              <Select.ScrollDownButton className="review-source-scroll">
                <ChevronDown size={16} />
              </Select.ScrollDownButton>
            </Select.Content>
          </Select.Portal>
        </Select.Root>
        <button
          type="button"
          className="review-refresh"
          disabled={loading}
          onClick={() => setRevision((value) => value + 1)}
        >
          <RefreshCw size={14} className={loading ? "review-spinning" : undefined} />
          刷新
        </button>
      </div>
      {entries.length ? (
        <div ref={scroll} className="review-change-list">
          <div className="review-virtual-list" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index];
              const isExpanded = expandedPath === entry.path;
              const diff = diffs[entry.id];
              return (
                <div
                  key={item.key}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  data-diff-id={entry.id}
                  className="review-change"
                  style={{ top: item.start }}
                >
                  {row(entry, isExpanded, () => setExpanded({ scope, path: isExpanded ? null : entry.path }))}
                  {isExpanded && (
                    <div className="review-change-content">
                      {diff ? (
                        <ReviewDiffViewer diff={diff} id={entry.id} searching={searching} />
                      ) : (
                        <div className="review-diff-loading">加载中...</div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="review-empty" role={current?.error ? "alert" : "status"}>
          <FileText size={32} />
          <p>{empty[0]}</p>
          <p>{empty[1]}</p>
        </div>
      )}
    </section>
  );
}
