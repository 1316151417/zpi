// Ported from ZCode command-center/CommandCenterDialog and quickPickStyles (Apache-2.0).
import * as Dialog from "@radix-ui/react-dialog";
import { Command } from "cmdk";
import { ChevronDown, File, List, MessageSquare, MessagesSquare, Rocket, Search } from "lucide-react";
import { type ComponentType, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { FileIcon } from "zpi-ui";
import type { ProjectRecord, SessionRecord, TaskSearchChange, TaskSearchResult } from "../shared/bridge.ts";
import type { TaskSearchSnippet } from "../shared/task-search.ts";
import { HighlightedMatchText } from "./HighlightedMatchText.tsx";
import { formatTaskRelativeTime } from "./sidebar-task-model.ts";
import { report, useStore } from "./store.ts";
import {
  type CommandCenterSearchHistoryEntry,
  type CommandCenterSearchScope,
  clearCommandCenterSearchHistory,
  pushCommandCenterSearchHistory,
  readCommandCenterSearchHistory,
} from "./task-search-history.ts";
import { Trash2 } from "./task-search-icons.ts";
import { resolveSearchScope, searchScopePrefix, taskSearchRows } from "./task-search-model.ts";
import { unwrap } from "./unwrap.ts";
import { useDialogDismiss } from "./use-dialog-dismiss.ts";
import { useOverlayShortcut } from "./use-overlay-shortcut.ts";
import { userErrorMessage } from "./user-error.ts";

export interface SearchCommand {
  id: string;
  title: string;
  section: "建议" | "面板" | "配置";
  keywords: string;
  icon: ComponentType<{ size?: number; className?: string }>;
  shortcut?: string;
  disabled?: boolean;
  run: () => unknown;
}
type SearchFile = Awaited<ReturnType<typeof window.zpi.listTaskFiles>> & { ok: true };
const scopes = [
  ["all", "全部", List],
  ["commands", "操作", Rocket],
  ["conversations", "任务", MessagesSquare],
  ["files", "文件", File],
] as const;
function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Command.Group heading={title} className="task-search-group">
      {children}
    </Command.Group>
  );
}
export function TaskSearchDialog({
  selected,
  workspaceKey,
  projects,
  commands,
  onClose: onClosed,
  onSelectTask,
  onOpenFile,
}: {
  selected?: string;
  workspaceKey: string;
  projects: ProjectRecord[];
  commands: SearchCommand[];
  onClose: () => void;
  onSelectTask: (task: SessionRecord, query?: string, snippet?: TaskSearchSnippet) => Promise<void>;
  onOpenFile: (path: string) => Promise<unknown>;
}) {
  const [open, close] = useDialogDismiss(onClosed);
  useOverlayShortcut("search", open, close);
  const input = useRef<HTMLInputElement>(null);
  const opener = useRef(document.activeElement);
  const composing = useRef(false);
  const [raw, setRaw] = useState("");
  const [manualScope, setManualScope] = useState<CommandCenterSearchScope>("all");
  const resolved = resolveSearchScope(raw);
  const scope = resolved.scope ?? manualScope;
  const query = resolved.query;
  const [expanded, setExpanded] = useState<Set<"conversations" | "files">>(() => new Set());
  const [historyExpanded, setHistoryExpanded] = useState(false);
  const [history, setHistory] = useState(() => readCommandCenterSearchHistory(workspaceKey));
  const [result, setResult] = useState<{ query: string; tasks: TaskSearchResult[] }>();
  const [taskError, setTaskError] = useState("");
  const [files, setFiles] = useState<SearchFile["value"]>();
  const [fileError, setFileError] = useState("");
  const [changes, setChanges] = useState<TaskSearchChange[]>([]);
  const actionSelected = useRef(false);
  const searchingTasks = scope === "all" || scope === "conversations";
  const searchingFiles = Boolean(query) && (scope === "all" || scope === "files");
  const taskRevision = useStore((state) =>
    [...state.sessions.values()]
      .filter((task) => !task.draft && !task.parentSessionId && task.archivedAt == null)
      .map((task) => `${task.id}:${task.title}:${task.updatedAt}`)
      .join("\n"),
  );
  useEffect(() => {
    setExpanded(new Set());
  }, [query, scope]);
  useEffect(() => {
    setTaskError("");
    if (!open || !searchingTasks) return;
    let cancelled = false;
    void window.zpi
      .searchTasks(query, !query && workspaceKey !== "ZPI" ? workspaceKey : null)
      .then(unwrap)
      .then((tasks) => {
        if (!cancelled) setResult({ query, tasks });
      })
      .catch((error) => {
        if (!cancelled) setTaskError(userErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, query, searchingTasks, scope, workspaceKey, taskRevision]);
  useEffect(() => {
    if (!open || !searchingFiles || files || fileError) return;
    let cancelled = false;
    void window.zpi
      .listTaskFiles(selected ?? null)
      .then(unwrap)
      .then((entries) => {
        if (!cancelled) setFiles(entries);
      })
      .catch((error) => {
        if (!cancelled) setFileError(userErrorMessage(error));
      });
    return () => {
      cancelled = true;
    };
  }, [open, searchingFiles, selected, files, fileError]);
  useEffect(() => {
    if (!open || !selected) return;
    let cancelled = false;
    void window.zpi
      .getTaskSearchChanges(selected)
      .then(unwrap)
      .then((items) => {
        if (!cancelled) setChanges(items);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, selected]);
  const tasks = result?.query === query ? result.tasks : [];
  const loadingTasks = searchingTasks && result?.query !== query && !taskError;
  const rows = useMemo(() => taskSearchRows(tasks, query), [tasks, query]);
  const fileRows = useMemo(() => {
    const parts = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    return query
      ? (files ?? [])
          .filter(
            (entry) =>
              entry.type === "file" &&
              parts.every((part) => `${entry.name} ${entry.path}`.toLocaleLowerCase().includes(part)),
          )
          .slice(0, 80)
      : [];
  }, [files, query]);
  const commandRows = commands.filter((command) =>
    query
      .trim()
      .toLocaleLowerCase()
      .split(/\s+/)
      .filter(Boolean)
      .every((part) => `${command.title} ${command.keywords}`.toLocaleLowerCase().includes(part)),
  );
  const run = (action: () => unknown, rememberScope?: CommandCenterSearchScope) => {
    if (query && rememberScope)
      setHistory(pushCommandCenterSearchHistory({ workspaceKey, query, scope: rememberScope }));
    actionSelected.current = true;
    close();
    void Promise.resolve().then(action).catch(report);
  };
  const recent = tasks.filter(
    (task) =>
      task.id !== selected &&
      (workspaceKey === "ZPI" ? task.projectId === null : (task.cwd ?? "") === workspaceKey),
  );
  const recentRows = scope === "conversations" ? recent : recent.slice(0, 3);
  const visibleRows = scope === "conversations" || expanded.has("conversations") ? rows : rows.slice(0, 3);
  const visibleFiles = scope === "files" || expanded.has("files") ? fileRows : fileRows.slice(0, 3);
  const hasResults =
    ((scope === "all" || scope === "commands") && commandRows.length > 0) ||
    (searchingTasks && rows.length > 0) ||
    (searchingFiles && fileRows.length > 0);
  const fileLoading = searchingFiles && !files && !fileError;
  const more = (section: "conversations" | "files", count: number) =>
    !expanded.has(section) && count > 3 && scope === "all" ? (
      <button
        type="button"
        className="task-search-more"
        onClick={() => setExpanded((current) => new Set(current).add(section))}
      >
        查看更多结果
        <ChevronDown size={14} />
      </button>
    ) : null;
  const taskItem = (task: SessionRecord, key = task.id, snippet?: TaskSearchSnippet) => {
    const label =
      projects.find((project) => project.id === task.projectId)?.name ??
      task.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ??
      "ZPI";
    return (
      <Command.Item
        key={key}
        value={key}
        className="task-search-item"
        onSelect={() =>
          run(() => onSelectTask(task, query || undefined, snippet), query ? "conversations" : undefined)
        }
      >
        <MessageSquare size={14} className="task-search-icon" />
        <span className={query ? "task-search-task-text" : "task-search-title"}>
          <span className="task-search-title">
            <HighlightedMatchText text={task.title.trim() || "未命名任务"} query={query} />
          </span>
          {snippet && (
            <span className="task-search-snippet">
              <HighlightedMatchText text={snippet.text} query={query} />
            </span>
          )}
        </span>
        {query && <span className="task-search-metadata">{label}</span>}
        <span className={query ? "task-search-timestamp" : "task-search-metadata"}>
          {formatTaskRelativeTime(task.updatedAt)}
        </span>
      </Command.Item>
    );
  };
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(value) => {
        if (!value) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="task-search-dialog"
          data-shortcut-owner="search"
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            input.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (actionSelected.current) {
              // Focus the selected hit after Radix releases the exiting dialog's focus scope.
              document.querySelector<HTMLInputElement>(".task-find-bar input")?.focus();
              return;
            }
            if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
          }}
          onEscapeKeyDown={(event) => {
            if (composing.current || event.isComposing || event.keyCode === 229) event.preventDefault();
          }}
        >
          <Dialog.Title className="task-search-sr-only">搜索任务</Dialog.Title>
          <Command
            shouldFilter={false}
            loop
            className="task-search-command"
            onKeyDownCapture={(event) => {
              if (composing.current || event.nativeEvent.isComposing || event.keyCode === 229) {
                if (event.key === "Enter" || event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                }
              }
            }}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) {
                event.stopPropagation();
              }
            }}
          >
            <div className="task-search-header">
              <div className="task-search-input-wrap">
                <Search size={16} />
                <Command.Input
                  ref={input}
                  onCompositionStart={() => {
                    composing.current = true;
                  }}
                  onCompositionEnd={() => {
                    composing.current = false;
                  }}
                  value={raw}
                  onValueChange={setRaw}
                  placeholder="搜索操作、任务或文件"
                  aria-label="搜索操作、任务或文件"
                />
              </div>
              <div role="tablist" aria-label="命令中心范围" className="task-search-scopes">
                {scopes.map(([value, label, Icon]) => (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={scope === value}
                    key={value}
                    onClick={() => {
                      setManualScope(value);
                      if (resolved.explicit) setRaw(query);
                      input.current?.focus();
                    }}
                  >
                    <Icon size={12} />
                    {label}
                  </button>
                ))}
              </div>
            </div>
            <Command.List className="task-search-list">
              {!query &&
                (scope === "all" || scope === "files") &&
                (changes.length > 0 || scope === "files") && (
                  <Section title="最近变更">
                    {changes.length ? (
                      changes.slice(0, scope === "files" ? undefined : 3).map((file) => (
                        <Command.Item
                          key={file.path}
                          value={`change:${file.path}`}
                          className="task-search-item"
                          onSelect={() => run(() => onOpenFile(file.path))}
                        >
                          <FileIcon path={file.path} size={14} />
                          <span className="task-search-title">
                            {file.path.startsWith(`${workspaceKey}/`)
                              ? file.path.slice(workspaceKey.length + 1)
                              : file.path}
                          </span>
                          <span className="task-search-metadata">
                            <span className="task-search-added">+{file.added}</span>{" "}
                            <span className="task-search-removed">-{file.removed}</span>
                          </span>
                        </Command.Item>
                      ))
                    ) : (
                      <div className="task-search-empty">当前任务暂无最近变更</div>
                    )}
                  </Section>
                )}
              {!query && searchingTasks && (recentRows.length > 0 || scope === "conversations") && (
                <Section title="最近任务">
                  {loadingTasks ? (
                    <div className="task-search-empty">正在搜索任务…</div>
                  ) : recentRows.length ? (
                    recentRows.map((task) => taskItem(task))
                  ) : (
                    <div className="task-search-empty">暂无最近任务</div>
                  )}
                </Section>
              )}
              {(scope === "all" || scope === "commands") &&
                ["建议", "面板", "配置"].map((section) => {
                  const items = commandRows.filter((command) => command.section === section);
                  return items.length ? (
                    <Section title={section} key={section}>
                      {items.map((command) => (
                        <Command.Item
                          key={command.id}
                          value={command.id}
                          disabled={command.disabled}
                          className="task-search-item"
                          onSelect={() => run(command.run, "commands")}
                        >
                          <command.icon size={14} className="task-search-icon" />
                          <span className="task-search-title">
                            <HighlightedMatchText text={command.title} query={query} />
                          </span>
                          {command.shortcut && (
                            <span className="task-search-shortcut">{command.shortcut}</span>
                          )}
                        </Command.Item>
                      ))}
                    </Section>
                  ) : null;
                })}
              {query && searchingTasks && (rows.length > 0 || loadingTasks || taskError) && (
                <Section title="任务">
                  {taskError ? (
                    <div role="alert" className="task-search-empty">
                      {taskError}
                    </div>
                  ) : loadingTasks ? (
                    <div className="task-search-empty">正在搜索任务…</div>
                  ) : (
                    visibleRows.map((row) => taskItem(row.task, row.key, row.snippet))
                  )}
                  {more("conversations", rows.length)}
                </Section>
              )}
              {query && searchingFiles && (fileRows.length > 0 || fileLoading || fileError) && (
                <Section title="文件">
                  {fileError ? (
                    <div role="alert" className="task-search-empty">
                      {fileError}
                    </div>
                  ) : fileLoading ? (
                    <div className="task-search-empty">正在加载文件…</div>
                  ) : (
                    visibleFiles.map((file) => (
                      <Command.Item
                        key={file.path}
                        value={`file:${file.path}`}
                        className="task-search-item"
                        onSelect={() => run(() => onOpenFile(file.absolutePath), "files")}
                      >
                        <FileIcon path={file.path} size={14} />
                        <span className="task-search-title">
                          <HighlightedMatchText text={file.name} query={query} />
                        </span>
                        {file.path.includes("/") && (
                          <span className="task-search-metadata">
                            <HighlightedMatchText
                              text={file.path.slice(0, file.path.lastIndexOf("/"))}
                              query={query}
                            />
                          </span>
                        )}
                      </Command.Item>
                    ))
                  )}
                  {more("files", fileRows.length)}
                </Section>
              )}
              {query &&
                !hasResults &&
                !loadingTasks &&
                !fileLoading &&
                !taskError &&
                (!searchingFiles || !fileError) && <div className="task-search-empty">暂无相关结果</div>}
            </Command.List>

            {!query && history.length > 0 && (
              <>
                <div className="task-search-history-heading">
                  搜索历史
                  <button
                    type="button"
                    aria-label="清除搜索历史"
                    onClick={() => {
                      clearCommandCenterSearchHistory(workspaceKey);
                      setHistory([]);
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className={`task-search-history ${historyExpanded ? "expanded" : ""}`}>
                  {history.map((entry: CommandCenterSearchHistoryEntry) => (
                    <button
                      type="button"
                      key={entry.query}
                      className="task-search-history-chip"
                      onClick={() => {
                        setManualScope(entry.scope);
                        setRaw(`${searchScopePrefix(entry.scope)}${entry.query}`);
                        input.current?.focus();
                      }}
                    >
                      {searchScopePrefix(entry.scope) && <span>{searchScopePrefix(entry.scope)}</span>}
                      <span>{entry.query}</span>
                    </button>
                  ))}
                  {history.length > 6 && (
                    <button
                      type="button"
                      className="task-search-history-expand"
                      aria-label={historyExpanded ? "折叠搜索历史" : "展开搜索历史"}
                      onClick={() => setHistoryExpanded(!historyExpanded)}
                    >
                      <ChevronDown
                        size={14}
                        style={{ transform: historyExpanded ? "rotate(180deg)" : undefined }}
                      />
                    </button>
                  )}
                </div>
              </>
            )}
          </Command>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
