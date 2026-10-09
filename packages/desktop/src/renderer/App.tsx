import {
  ActionHint,
  ChatComposer,
  type ComposerContext,
  Conversation,
  type FileAction,
  type FileLocation,
  TaskFindBar,
  type WebOpenOptions,
} from "ZPI-ui";
import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Ellipsis,
  Folder,
  FolderOpen,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Plus,
  Settings,
  X,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import type { InterfacePreferences, SessionRecord } from "../shared/bridge.ts";
import { sidebarLimits, taskPinLimit } from "../shared/config.ts";
import { DirectoryMenuItems } from "./DirectoryMenuItems.tsx";
import { DraftProjectPicker } from "./DraftProjectPicker.tsx";
import { readMarkdownImage } from "./markdown-image.ts";
import {
  listenPanes,
  openWebLink,
  paneTask,
  setPaneOpen,
  openChanges as showChanges,
  openFile as showFile,
  usePane,
} from "./pane-store.ts";
import { previewServices } from "./preview-services.ts";
import { RightPane } from "./RightPane.tsx";
import { SessionToolbar } from "./SessionToolbar.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import { SidebarSections } from "./SidebarSections.tsx";
import { SidebarTaskEmpty, SidebarTaskList } from "./SidebarTaskList.tsx";
import { SidebarTaskRow } from "./SidebarTaskRow.tsx";
import {
  compareTasks,
  readTaskPreferences,
  retainProjectLimits,
  taskPage,
  taskPreferencesKey,
} from "./sidebar-task-model.ts";
import {
  addConversationSelection,
  archiveSession,
  drafts,
  initialize,
  loadEarlier,
  newSession,
  refresh,
  report,
  resetSession,
  selectSession,
  subscribeEvents,
  unwrap,
  useStore,
  withdrawQueuedInput,
} from "./store.ts";
import { TaskMenu } from "./TaskMenu.tsx";
import { TaskViewMenu } from "./TaskViewMenu.tsx";
import { playTaskNotificationSound } from "./task-notification-sound.ts";
import { useDialogDismiss } from "./use-dialog-dismiss.ts";
import { useStopOnEscape } from "./use-stop-on-escape.ts";
import { useTaskFind } from "./use-task-find.ts";
import { useWorkspace } from "./use-workspace.ts";
import { WindowChrome } from "./WindowChrome.tsx";

const inputContext: ComposerContext = {
  readImage: readMarkdownImage,
  downloadImage: (src) => window.ZPI.downloadImage(src).then(unwrap),
  searchFiles: (id, q) => window.ZPI.searchFiles(id, q).then(unwrap),
  pickAttachments: (id) => window.ZPI.pickAttachments(id).then(unwrap),
  importAttachment: (id, file) => window.ZPI.importAttachment(id, file).then(unwrap),
  removeAttachment: (id, image) => window.ZPI.removeAttachment(id, image).then(unwrap),
  readAttachment: async (id, image) => {
    const result = unwrap(await window.ZPI.readAttachment(id, image));
    return `data:${result.metadata.mimeType};base64,${result.data}`;
  },
};
interface ActionDialog {
  title: string;
  value?: string;
  onConfirm: (value: string) => Promise<void>;
}
function ActionModal({ action, onClose: onClosed }: { action: ActionDialog; onClose: () => void }) {
  const [open, onClose] = useDialogDismiss(onClosed);
  const opener = useRef(
    document.getElementById(
      document.activeElement?.closest('[role="menu"]')?.getAttribute("aria-labelledby") ?? "",
    ) ?? document.activeElement,
  );
  const [value, setValue] = useState(action.value ?? "");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const confirming = useRef(false);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-backdrop" />
        <Dialog.Content
          className="modal"
          aria-label={action.title}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
          }}
        >
          <form
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229))
                event.preventDefault();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (confirming.current) return;
              confirming.current = true;
              setBusy(true);
              void action.onConfirm(value).then(onClose, (e) => {
                setError(String(e));
                confirming.current = false;
                setBusy(false);
              });
            }}
          >
            <Dialog.Title asChild>
              <h2>{action.title}</h2>
            </Dialog.Title>
            <label>
              名称
              <input aria-label="名称" value={value} onChange={(e) => setValue(e.target.value)} />
            </label>
            {error && <div className="run-error">{error}</div>}
            <div className="modal-actions">
              <button type="button" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="primary" disabled={busy}>
                确认
              </button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function openLink(url: string, options?: WebOpenOptions): void {
  paneTask(openWebLink(url, options));
}
export function App() {
  const state = useStore(
    useShallow((s) => ({
      projects: s.projects,
      sessions: s.sessions,
      selected: s.selected,
      settings: s.settings,
      error: s.error,
      ready: s.ready,
      activeView: s.selected ? s.views.get(s.selected) : undefined,
      activeSuggestions: s.suggestions.get(s.selected ?? ""),
      activeDiagnostics: s.resourceDiagnostics.get(s.selected ?? ""),
      historyCursors: s.historyCursors,
      historyLoading: s.historyLoading,
    })),
  );

  const paneOpen = usePane((s) => s.open),
    paneRatio = usePane((s) => s.ratio);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [action, setAction] = useState<ActionDialog>();
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const resizing = useRef(false);
  const oldSelect = useRef("");
  const prefs = state.settings?.interface;
  const collapsed = prefs?.sidebarCollapsed ?? false;
  const [taskPreferences, setTaskPreferences] = useState(() => {
    try {
      return readTaskPreferences(localStorage.getItem(taskPreferencesKey));
    } catch {
      return readTaskPreferences(null);
    }
  });
  const [projectLimits, setProjectLimits] = useState<Record<string, number>>({});
  useEffect(() => {
    try {
      localStorage.setItem(taskPreferencesKey, JSON.stringify(taskPreferences));
    } catch {
      /* Optional local preferences. */
    }
  }, [taskPreferences]);
  useEffect(() => {
    const visible = new Set(
      taskPreferences.organizeBy === "project" && !prefs?.projectsCollapsed
        ? state.projects.filter((p) => !prefs?.collapsedProjectIds.includes(p.id)).map((p) => p.id)
        : [],
    );
    setProjectLimits((current) => retainProjectLimits(current, visible));
  }, [state.projects, prefs?.projectsCollapsed, prefs?.collapsedProjectIds, taskPreferences.organizeBy]);
  const boundedWidth = (width: number) =>
    Math.max(
      sidebarLimits.min,
      Math.min(sidebarLimits.max, viewport - sidebarLimits.chatMin - sidebarLimits.resizer, width),
    );
  const width = collapsed
    ? sidebarLimits.collapsed
    : boundedWidth(dragWidth ?? prefs?.sidebarWidth ?? sidebarLimits.default);
  const updatePrefs = (input: Partial<InterfacePreferences>) => {
    void window.ZPI.updatePreferences(input)
      .then(unwrap)
      .then((settings) => useStore.setState({ settings }))
      .catch(report);
  };
  useEffect(() => {
    const resize = () => setViewport(window.innerWidth);
    window.addEventListener("resize", resize);
    return () => {
      window.removeEventListener("resize", resize);
      if (resizing.current) document.body.style.userSelect = oldSelect.current;
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeEvents();
    const offPanes = listenPanes();
    const offNotificationClick = window.ZPI.onTaskNotificationClick((id) => {
      void refresh()
        .then(async () => {
          if (!useStore.getState().sessions.has(id)) return;
          setSettingsOpen(false);
          setModelOpen(false);
          setAction(undefined);
          await selectSession(id);
        })
        .catch(report);
    });
    const offNotificationSound = window.ZPI.onTaskNotificationSound(() => {
      void playTaskNotificationSound();
    });
    const offSettings = window.ZPI.onSettings((settings) => {
      useStore.setState({ settings });
      void refresh().catch(report);
    });
    void initialize();
    return () => {
      unsubscribe();
      offPanes();
      offNotificationClick();
      offNotificationSound();
      offSettings();
    };
  }, []);
  const selected = state.selected;
  const addSelection = useCallback(
    (reference: import("ZPI-ui").ConversationSelection) => addConversationSelection(reference, selected),
    [selected],
  );
  const workspace = useWorkspace(selected);
  const views = useStore.getState().views;
  const view = selected ? views.get(selected) : undefined;
  const find = useTaskFind(selected, Boolean(view) && !settingsOpen && !action);
  const records = useMemo(
    () => [...state.sessions.values()].filter((record) => !record.draft),
    [state.sessions],
  );
  const record = selected ? state.sessions.get(selected) : undefined;
  const taskTitle = record?.draft ? "新任务" : (record?.title ?? view?.title ?? "新任务");
  const diagnostics = [
    ...new Map(
      [...(view?.controls?.diagnostics ?? []), ...(state.activeDiagnostics ?? [])].map((d) => [
        `${d.path}:${d.message}`,
        d,
      ]),
    ).values(),
  ];
  const activeRun = view?.runs.find((r) => r.status === "running");
  const stop = useCallback(() => {
    if (selected && activeRun)
      void window.ZPI.abortRun({ sessionId: selected, runId: activeRun.runId }).then(unwrap).catch(report);
  }, [selected, activeRun?.runId]);
  useStopOnEscape(activeRun ? stop : undefined);
  const copyCode = useCallback((text: string) => window.ZPI.copyText(text).then(unwrap), []);
  const openFile = useCallback(
    (path: string, location?: FileLocation) => {
      if (selected) paneTask(showFile(selected, path, location));
    },
    [selected],
  );
  const openChanges = useCallback(
    (runId: string, path?: string, toolCallId?: string) => {
      if (selected) showChanges(selected, runId, path, toolCallId);
    },
    [selected],
  );
  const loadToolPatch = useCallback(
    (runId: string, toolCallId: string) => {
      if (!selected) return Promise.reject(new Error("任务未选中"));
      return window.ZPI.readPatch(selected, runId, `operation:${toolCallId}`).then(unwrap);
    },
    [selected],
  );
  const fileAction = useCallback(
    (path: string, action: FileAction, location?: FileLocation) =>
      selected ? window.ZPI.fileAction(selected, path, action, location).then(unwrap) : Promise.resolve(),
    [selected],
  );
  const earlier = useCallback(
    () => (selected ? loadEarlier(selected).catch(report) : Promise.resolve()),
    [selected],
  );
  const addProject = async () => {
    try {
      const p = unwrap(await window.ZPI.addProject());
      if (p) {
        await refresh();
        if (![...useStore.getState().sessions.values()].some((r) => r.projectId === p.id))
          await newSession(p.id);
      }
    } catch (e) {
      report(e);
    }
  };
  const task = (fn: () => Promise<unknown>) => {
    void fn().catch(report);
  };
  const pinned = records
    .filter((r) => r.pinnedAt != null)
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
  const unpinned = records
    .filter((r) => r.pinnedAt == null && r.archivedAt == null)
    .sort((a, b) => compareTasks(a, b, taskPreferences.sortBy));
  const projectIds = new Set(state.projects.map((p) => p.id));
  const allProjectGroupsExpanded =
    !prefs?.projectsCollapsed && state.projects.every((p) => !prefs?.collapsedProjectIds.includes(p.id));
  const toggleProjectGroupsLabel = allProjectGroupsExpanded ? "收起全部" : "展开全部";
  const tasks = unpinned.filter((r) => r.projectId === null || !projectIds.has(r.projectId));
  const pinnedCount = pinned.length;
  const renderRow = (r: SessionRecord, variant: "default" | "timeline" = "default") => (
    <SidebarTaskRow
      key={r.id}
      record={r}
      active={selected === r.id}
      variant={variant}
      workspace={r.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "ZPI"}
      pinLimitReached={pinnedCount >= taskPinLimit}
      onSelect={() => {
        setModelOpen(false);
        task(() => selectSession(r.id));
      }}
      onPin={() =>
        task(async () => {
          unwrap(await window.ZPI.setSessionPinned(r.id, r.pinnedAt == null));
          await refresh();
        })
      }
      onArchive={() => task(() => archiveSession(r.id))}
    />
  );
  const scopeKey = state.projects.map((p) => p.id).join(":");
  const paneWidth = Math.max(
    300,
    Math.min((viewport - width) * paneRatio, viewport - width - (viewport >= 1100 ? 380 : 60)),
  );
  return (
    <div
      className={`shell ${window.ZPI.platform === "darwin" ? "mac-desktop" : ""} ${collapsed ? "left-collapsed" : ""} ${paneOpen ? "pane-open" : ""} ${settingsOpen ? "show-settings" : ""}`}
      style={
        {
          "--left-sidebar-width": `${width}px`,
          "--sidebar-content-width": `${boundedWidth(dragWidth ?? prefs?.sidebarWidth ?? sidebarLimits.default)}px`,
          "--right-pane-width": `${paneWidth}px`,
          "--workspace-panel-radius": `${window.ZPI.workspacePanelRadius}px`,
        } as CSSProperties
      }
    >
      <div className="workspace-surface" aria-hidden={settingsOpen} inert={settingsOpen}>
        <WindowChrome
          leftCollapsed={collapsed}
          rightOpen={paneOpen}
          hidden={settingsOpen}
          onNewTask={() => task(() => newSession())}
          onToggleLeft={() => updatePrefs({ sidebarCollapsed: !collapsed })}
          onToggleRight={() => setPaneOpen(!paneOpen)}
        />
        {useMemo(
          () => (
            <aside className="sidebar" hidden={collapsed} inert={collapsed}>
              <div className="sidebar-global">
                <button aria-label="新建任务" onClick={() => task(() => newSession())}>
                  <MessageCirclePlus size={16} />
                  新建任务
                </button>
              </div>
              <div className="sidebar-sections">
                <div className="sidebar-task-toolbar">
                  <div className="sidebar-task-toolbar-main">
                    <TaskViewMenu value={taskPreferences} onChange={setTaskPreferences} viewOnly />
                    {taskPreferences.organizeBy === "project" && state.projects.length > 0 && (
                      <ActionHint label={toggleProjectGroupsLabel} appearance="control">
                        <button
                          className="task-group-toggle"
                          aria-label={toggleProjectGroupsLabel}
                          onClick={() =>
                            updatePrefs({
                              projectsCollapsed: allProjectGroupsExpanded,
                              collapsedProjectIds: allProjectGroupsExpanded
                                ? [...new Set([...(prefs?.collapsedProjectIds ?? []), ...projectIds])]
                                : (prefs?.collapsedProjectIds ?? []).filter((id) => !projectIds.has(id)),
                            })
                          }
                        >
                          {allProjectGroupsExpanded ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
                        </button>
                      </ActionHint>
                    )}
                  </div>
                  <TaskViewMenu value={taskPreferences} onChange={setTaskPreferences} />
                </div>
                {pinned.length > 0 && (
                  <section className="pinned-tasks" aria-label="置顶任务">
                    <h3 className="sidebar-heading">已置顶</h3>
                    {pinned.map((record) => renderRow(record))}
                  </section>
                )}
                {taskPreferences.organizeBy === "chronological" ? (
                  <SidebarTaskList
                    key={`timeline:${taskPreferences.sortBy}:${scopeKey}`}
                    tasks={unpinned}
                    sortBy={taskPreferences.sortBy}
                    timeline
                    renderRow={renderRow}
                  />
                ) : (
                  <SidebarSections
                    projects={{
                      title: "项目",
                      open: !prefs?.projectsCollapsed,
                      onToggle: () => updatePrefs({ projectsCollapsed: !prefs?.projectsCollapsed }),
                      action: (
                        <ActionHint label="添加项目" appearance="control">
                          <button
                            aria-label="添加项目"
                            className="muted-icon"
                            onClick={() => void addProject()}
                          >
                            <Plus size={14} aria-hidden="true" />
                          </button>
                        </ActionHint>
                      ),
                      children: (
                        <div className="projects" hidden={prefs?.projectsCollapsed}>
                          {state.projects.map((p) => (
                            <section key={p.id} className="project">
                              <div className="project-title">
                                <button
                                  className="project-toggle muted-icon"
                                  aria-label={`${prefs?.collapsedProjectIds.includes(p.id) ? "展开" : "收起"}项目 ${p.name}`}
                                  aria-expanded={!prefs?.collapsedProjectIds.includes(p.id)}
                                  onClick={() =>
                                    updatePrefs({
                                      collapsedProjectIds: prefs?.collapsedProjectIds.includes(p.id)
                                        ? prefs.collapsedProjectIds.filter((id) => id !== p.id)
                                        : [...(prefs?.collapsedProjectIds ?? []), p.id],
                                    })
                                  }
                                >
                                  {prefs?.collapsedProjectIds.includes(p.id) ? (
                                    <Folder size={14} />
                                  ) : (
                                    <FolderOpen size={14} />
                                  )}
                                </button>
                                <button
                                  className="project-name"
                                  onClick={() =>
                                    updatePrefs({
                                      collapsedProjectIds: prefs?.collapsedProjectIds.includes(p.id)
                                        ? prefs.collapsedProjectIds.filter((id) => id !== p.id)
                                        : [...(prefs?.collapsedProjectIds ?? []), p.id],
                                    })
                                  }
                                >
                                  {p.name}
                                </button>
                                <Menu.Root>
                                  <ActionHint label="更多" appearance="control">
                                    <Menu.Trigger
                                      className="project-row-action"
                                      aria-label={`项目操作 ${p.name}`}
                                    >
                                      <Ellipsis size={14} />
                                    </Menu.Trigger>
                                  </ActionHint>
                                  <Menu.Portal>
                                    <Menu.Content
                                      className="project-action-menu"
                                      align="end"
                                      sideOffset={4}
                                      aria-label={`项目操作 ${p.name}`}
                                    >
                                      <Menu.Item
                                        className="project-action-menu-item"
                                        onSelect={() =>
                                          task(async () => {
                                            unwrap(await window.ZPI.removeProject(p.id));
                                            await refresh();
                                          })
                                        }
                                      >
                                        <X size={14} />
                                        移除
                                      </Menu.Item>
                                      <Menu.Separator className="menu-separator" />
                                      <DirectoryMenuItems
                                        className="project-action-menu-item"
                                        getPath={async () => p.path}
                                      />
                                    </Menu.Content>
                                  </Menu.Portal>
                                </Menu.Root>
                                <ActionHint label="新建任务" appearance="control">
                                  <button
                                    aria-label={`新建任务 ${p.name}`}
                                    className="project-row-action"
                                    onClick={() => task(() => newSession(p.id))}
                                  >
                                    <MessageCirclePlus size={14} />
                                  </button>
                                </ActionHint>
                              </div>
                              {!prefs?.projectsCollapsed &&
                                !prefs?.collapsedProjectIds.includes(p.id) &&
                                (() => {
                                  const limit = projectLimits[p.id] ?? 5;
                                  const page = taskPage(
                                    unpinned.filter((r) => r.projectId === p.id),
                                    limit,
                                  );
                                  return (
                                    <div
                                      className="project-task-list"
                                      data-project-id={p.id}
                                      data-task-limit={limit}
                                    >
                                      {page.items.length ? (
                                        <div className="task-list-rows">
                                          {page.items.map((record) => renderRow(record))}
                                        </div>
                                      ) : (
                                        <SidebarTaskEmpty project />
                                      )}
                                      {page.hasMore && (
                                        <div className="task-show-more">
                                          <button
                                            onClick={() =>
                                              setProjectLimits((current) => ({
                                                ...current,
                                                [p.id]: (current[p.id] ?? 5) + 5,
                                              }))
                                            }
                                          >
                                            显示更多
                                          </button>
                                        </div>
                                      )}
                                    </div>
                                  );
                                })()}
                            </section>
                          ))}
                          {!state.projects.length && (
                            <div className="sidebar-empty">添加项目，按工作目录管理任务。</div>
                          )}
                        </div>
                      ),
                    }}
                    tasks={{
                      title: "任务",
                      open: !prefs?.tasksCollapsed,
                      onToggle: () => updatePrefs({ tasksCollapsed: !prefs?.tasksCollapsed }),
                      action: (
                        <ActionHint label="新建任务" appearance="control">
                          <button
                            aria-label="新建任务"
                            className="muted-icon"
                            onClick={() => task(() => newSession(null))}
                          >
                            <MessageCirclePlus size={14} aria-hidden="true" />
                          </button>
                        </ActionHint>
                      ),
                      children: !prefs?.tasksCollapsed && (
                        <SidebarTaskList
                          key={`tasks:${taskPreferences.sortBy}:${scopeKey}`}
                          tasks={tasks}
                          sortBy={taskPreferences.sortBy}
                          renderRow={renderRow}
                        />
                      ),
                    }}
                  />
                )}
              </div>
              <div className="sidebar-footer">
                {/* 仅重挂载提示，关闭隐藏触发器的 tooltip，同时保留侧栏分页和滚动位置。 */}
                <ActionHint key={settingsOpen ? "settings" : "workspace"} label="设置" appearance="control">
                  <button aria-label="设置" onClick={() => setSettingsOpen(true)}>
                    <Settings size={16} />
                    设置
                  </button>
                </ActionHint>
              </div>
            </aside>
          ),
          [
            settingsOpen,
            collapsed,
            width,
            records,
            state.projects,
            selected,
            prefs,
            taskPreferences,
            projectLimits,
          ],
        )}
        {!collapsed && (
          <hr
            className="sidebar-resizer"
            aria-label="侧边栏宽度"
            aria-orientation="vertical"
            aria-valuemin={sidebarLimits.min}
            aria-valuemax={Math.max(
              sidebarLimits.min,
              Math.min(sidebarLimits.max, viewport - sidebarLimits.chatMin - sidebarLimits.resizer),
            )}
            aria-valuenow={width}
            tabIndex={0}
            onPointerDown={(e) => {
              resizing.current = true;
              e.currentTarget.parentElement?.setAttribute("data-sidebar-resizing", "true");
              oldSelect.current = document.body.style.userSelect;
              document.body.style.userSelect = "none";
              e.currentTarget.setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              if (resizing.current) setDragWidth(boundedWidth(e.clientX));
            }}
            onPointerUp={(e) => {
              if (!resizing.current) return;
              resizing.current = false;
              e.currentTarget.parentElement?.removeAttribute("data-sidebar-resizing");
              document.body.style.userSelect = oldSelect.current;
              e.currentTarget.releasePointerCapture(e.pointerId);
              updatePrefs({ sidebarWidth: boundedWidth(e.clientX) });
              setDragWidth(undefined);
            }}
            onPointerCancel={() => {
              resizing.current = false;
              document.querySelector(".workspace-surface")?.removeAttribute("data-sidebar-resizing");
              document.body.style.userSelect = oldSelect.current;
              setDragWidth(undefined);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                e.preventDefault();
                updatePrefs({ sidebarWidth: boundedWidth(width + (e.key === "ArrowRight" ? 16 : -16)) });
              }
            }}
            onDoubleClick={() => updatePrefs({ sidebarWidth: sidebarLimits.default })}
          />
        )}
        <main className={`main ${record?.draft ? "draft-main" : ""}`}>
          <header className="topbar">
            <div className="topbar-title" title={taskTitle}>
              <Folder size={16} />
              <span>{taskTitle}</span>
            </div>
            {record && !record.draft && !record.diagnostic && (
              <TaskMenu
                record={record}
                onRename={() =>
                  setAction({
                    title: "重命名任务",
                    value: record.title,
                    onConfirm: async (name) => {
                      unwrap(await window.ZPI.renameSession(record.id, name));
                      await refresh();
                    },
                  })
                }
              />
            )}
            <div className="topbar-drag-space" aria-hidden="true" />
          </header>
          {state.error && (
            <div className="error-toast" role="alert">
              {state.error}
              <button aria-label="关闭错误" onClick={() => useStore.setState({ error: undefined })}>
                <X size={13} />
              </button>
            </div>
          )}
          {state.settings?.providers.some((p) => p.hasApiKey || p.chatgptAccount?.connected) &&
            !state.settings.credentialsPersisted && (
              <div className="banner">系统加密不可用，凭据仅保存在本次应用内存中。</div>
            )}
          {!state.settings?.providers.some((p) => p.models.length) && state.ready && (
            <div className="banner">先在设置中添加提供商和模型。</div>
          )}
          {view ? (
            <div className="task-body">
              <Conversation
                previewServices={previewServices}
                findRequest={find.open && find.scope === "conversation" ? find.request : undefined}
                onFindStateChange={find.update}
                findBar={
                  find.open ? (
                    <TaskFindBar
                      request={find.request}
                      state={find.state}
                      scope={find.scope}
                      focusRequestId={find.focusRequestId}
                      onChange={find.change}
                      onNavigate={find.navigate}
                      onToggleScope={find.toggleScope}
                      onClose={find.close}
                    />
                  ) : undefined
                }
                workspace={workspace}
                view={view}
                onNavigateOrigin={(origin) => {
                  void (async () => {
                    if (!useStore.getState().sessions.has(origin.sessionId))
                      throw new Error("原任务已不存在");
                    await selectSession(origin.sessionId);
                    while (
                      !useStore
                        .getState()
                        .views.get(origin.sessionId)
                        ?.runs.some((run) => run.runId === origin.runId) &&
                      useStore.getState().historyCursors.get(origin.sessionId) != null
                    ) {
                      if (useStore.getState().selected !== origin.sessionId) return;
                      const cursor = useStore.getState().historyCursors.get(origin.sessionId);
                      await loadEarlier(origin.sessionId);
                      if (useStore.getState().historyCursors.get(origin.sessionId) === cursor) break;
                    }
                    requestAnimationFrame(() =>
                      window.dispatchEvent(new CustomEvent("ZPI:scroll-to-run", { detail: origin })),
                    );
                  })().catch(report);
                }}
                onAddSelection={addSelection}
                onEdit={async (runId, input) => {
                  const result = unwrap(await window.ZPI.editUserMessage(view.sessionId, runId, input));
                  if ("conflicts" in result) return result;
                  resetSession(result);
                }}
                onFork={async (runId) => {
                  const child = unwrap(await window.ZPI.forkSession(view.sessionId, runId));
                  await refresh();
                  await selectSession(child.id);
                }}
                historyCursor={state.historyCursors.get(view.sessionId)}
                hasEarlier={state.historyCursors.get(view.sessionId) != null}
                loadingEarlier={state.historyLoading.has(view.sessionId)}
                onLoadEarlier={earlier}
                onLink={openLink}
                context={inputContext}
                onChanges={openChanges}
                onLoadToolPatch={loadToolPatch}
                onFileAction={fileAction}
                onCopy={copyCode}
                onFile={openFile}
              />
              <div className="composer-container">
                {Boolean(diagnostics.length) && (
                  <details className="resource-diagnostics">
                    <summary>资源加载诊断（{diagnostics.length}）</summary>
                    {diagnostics.map((d) => (
                      <p key={d.path}>
                        {d.path}: {d.message}
                      </p>
                    ))}
                  </details>
                )}
                <ChatComposer
                  sessionId={view.sessionId}
                  draftStorage={drafts}
                  historyScope={record?.cwd}
                  sentMessages={view.runs.map((run) => run.userMessage)}
                  header={record?.draft ? <DraftProjectPicker projectId={record.projectId} /> : undefined}
                  onFile={openFile}
                  context={inputContext}
                  busy={Boolean(activeRun)}
                  queue={view.queue}
                  queueActions={{
                    edit: (itemId) => withdrawQueuedInput(view.sessionId, itemId),
                    remove: (itemId) => window.ZPI.removeQueuedInput(view.sessionId, itemId).then(unwrap),
                    sendNow: (itemId) => window.ZPI.sendQueuedNow(view.sessionId, itemId).then(unwrap),
                    move: (itemId, beforeId) =>
                      window.ZPI.moveQueuedInput(view.sessionId, itemId, beforeId).then(unwrap),
                    resume: () => window.ZPI.resumeInputQueue(view.sessionId).then(unwrap),
                  }}
                  showSendButton={prefs?.showSendButton ?? false}
                  toolbar={
                    <SessionToolbar
                      view={view}
                      open={modelOpen}
                      onOpenChange={setModelOpen}
                      onSettings={() => setSettingsOpen(true)}
                    />
                  }
                  suggestions={state.activeSuggestions ?? []}
                  onSubmit={async (text, input) => {
                    try {
                      const result = await window.ZPI.submitInput({
                        sessionId: view.sessionId,
                        text,
                        ...input,
                      });
                      if (
                        !result.ok &&
                        result.error.code === "configuration" &&
                        !view.controls?.selectionValid
                      ) {
                        setModelOpen(true);
                        throw new Error("selection_required");
                      }
                      if (unwrap(result).confirmationRequired) return "confirmationRequired";
                      useStore.setState({ error: undefined });
                      void refresh().catch(report);
                    } catch (e) {
                      if (!(e instanceof Error && e.message === "selection_required")) report(e);
                      throw e;
                    }
                  }}
                  onStop={stop}
                />
              </div>
            </div>
          ) : (
            <div className="empty-chat" role="status">
              {state.ready ? "新建或选择一个任务开始对话" : "正在准备任务…"}
            </div>
          )}
        </main>
        <RightPane
          width={paneWidth}
          available={viewport - width}
          sessionId={selected}
          findRequest={find.open && find.scope === "changes" ? find.request : undefined}
          onFindStateChange={find.update}
        />
      </div>
      {action && <ActionModal action={action} onClose={() => setAction(undefined)} />}
      {useMemo(
        () => (settingsOpen ? <SettingsPage onClose={() => setSettingsOpen(false)} /> : null),
        [settingsOpen],
      )}
    </div>
  );
}
