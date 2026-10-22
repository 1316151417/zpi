// UI adapted from ZCode GitPane / GitPaneChangeCard (Apache-2.0).
import * as Context from "@radix-ui/react-context-menu";
import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, Copy, FileText, FolderOpen, ListTree, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { DiffView, FileIcon, type FindRequest, type FindState } from "zpi-ui";
import type { DiffItem } from "../shared/bridge.ts";
import { type ReviewSnapshot, type ReviewSource, reviewPatchStats, reviewSources } from "../shared/review.ts";
import { openFile, openFileManager, paneTask } from "./pane-store.ts";
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
  const entries = snapshot?.entries ?? [];
  const load = useCallback(
    (id: string) => {
      if (source === "last-turn")
        return window.zpi.readPatch(sessionId, snapshot?.runId ?? null, id).then(unwrap);
      const entry = entries.find((entry) => entry.id === id);
      return entry
        ? window.zpi.readReviewPatch(sessionId, source, entry.path).then(unwrap)
        : Promise.resolve("");
    },
    [sessionId, source, snapshot?.runId, entries],
  );
  const open = useCallback(
    (id: string) => {
      const entry = entries.find((entry) => entry.id === id);
      if (entry) paneTask(openFile(sessionId, entry.path));
    },
    [sessionId, entries],
  );
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
            <button
              type="button"
              className="review-file-row"
              aria-expanded={expanded}
              title={path}
              onClick={toggle}
            >
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
        ? ["加载中…", "正在读取当前工作区的 Git 状态和文件改动。"]
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
    <section className="review-pane" aria-label="审查">
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
        <DiffView
          key={scope}
          entries={entries}
          loadPatch={load}
          openFile={open}
          renderReviewRow={row}
          findRequest={visible ? findRequest : undefined}
          onFindStateChange={onFindStateChange}
        />
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
