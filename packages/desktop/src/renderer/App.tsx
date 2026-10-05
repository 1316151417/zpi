import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Archive,
  ChevronDown,
  ChevronRight,
  Ellipsis,
  Folder,
  FolderOpen,
  LoaderIcon,
  MessageCirclePlus,
  Pin,
  Settings,
  X,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChatComposer,
  type ComposerContext,
  Conversation,
  type FileLocation,
  type WebOpenOptions,
} from "zpi-ui";
import { useShallow } from "zustand/react/shallow";
import type { InterfacePreferences, SessionRecord } from "../shared/bridge.ts";
import { sidebarLimits, taskPinLimit } from "../shared/config.ts";
import { DraftProjectPicker } from "./DraftProjectPicker.tsx";
import { readMarkdownImage } from "./markdown-image.ts";
import {
  listenPanes,
  openWebLink,
  paneTask,
  openChanges as showChanges,
  openFile as showFile,
  usePane,
} from "./pane-store.ts";
import { RightPane } from "./RightPane.tsx";
import { SessionToolbar } from "./SessionToolbar.tsx";
import { SettingsPage } from "./SettingsPage.tsx";
import {
  drafts,
  initialize,
  loadEarlier,
  newSession,
  refresh,
  report,
  selectSession,
  subscribeEvents,
  unwrap,
  useStore,
  withdrawQueuedInput,
} from "./store.ts";
import { useWorkspace } from "./use-workspace.ts";
import { WindowChrome } from "./WindowChrome.tsx";

const inputContext: ComposerContext = {
  readImage: readMarkdownImage,
  downloadImage: (src) => window.zpi.downloadImage(src).then(unwrap),
  searchFiles: (id, q) => window.zpi.searchFiles(id, q).then(unwrap),
  importImage: async (id, file) =>
    unwrap(await window.zpi.importImage(id, file.name, new Uint8Array(await file.arrayBuffer()))),
  pickImages: (id) => window.zpi.pickImages(id).then(unwrap),
  removeAttachment: (id, image) => window.zpi.removeAttachment(id, image).then(unwrap),
  readAttachment: async (id, image) => {
    const result = unwrap(await window.zpi.readAttachment(id, image));
    return `data:${result.metadata.mimeType};base64,${result.data}`;
  },
};
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
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const resizing = useRef(false);
  const oldSelect = useRef("");
  const prefs = state.settings?.interface;
  const collapsed = prefs?.sidebarCollapsed ?? false;
  const boundedWidth = (width: number) =>
    Math.max(
      sidebarLimits.min,
      Math.min(sidebarLimits.max, viewport - sidebarLimits.chatMin - sidebarLimits.resizer, width),
    );
  const width = collapsed
    ? sidebarLimits.collapsed
    : boundedWidth(dragWidth ?? prefs?.sidebarWidth ?? sidebarLimits.default);
  const updatePrefs = (input: Partial<InterfacePreferences>) => {
    void window.zpi
      .updatePreferences(input)
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
    const offSettings = window.zpi.onSettings((settings) => {
      useStore.setState({ settings });
      void refresh().catch(report);
    });
    void initialize();
    return () => {
      unsubscribe();
      offPanes();
      offSettings();
    };
  }, []);
  const selected = state.selected;
  const workspace = useWorkspace(selected);
  const views = useStore.getState().views;
  const view = selected ? views.get(selected) : undefined;
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
  const copyCode = useCallback((text: string) => window.zpi.copyText(text).then(unwrap), []);
  const openFile = useCallback(
    (path: string, location?: FileLocation) => {
      if (selected) paneTask(showFile(selected, path, location));
    },
    [selected],
  );
  const openChanges = useCallback(
    (runId: string, path?: string) => {
      if (selected) showChanges(selected, runId, path);
    },
    [selected],
  );
  const earlier = useCallback(
    () => (selected ? loadEarlier(selected).catch(report) : Promise.resolve()),
    [selected],
  );
  const addProject = async () => {
    try {
      const p = unwrap(await window.zpi.addProject());
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
  const pinnedCount = records.filter((record) => record.pinnedAt != null).length;
  const renderRow = (r: SessionRecord) => (
    <div
      key={r.id}
      className={`session-row ${selected === r.id ? "active" : ""}`}
      data-testid="session-row"
      data-session-id={r.id}
      data-status={r.status ?? "idle"}
      title={`${r.projectId === null ? "无项目" : (state.projects.find((p) => p.id === r.projectId)?.name ?? "原项目")} · ${r.cwd ?? r.diagnostic ?? ""}`}
    >
      <span className="task-leading-slot">
        <span className="task-indicator" aria-hidden="true">
          {r.status === "running" ? (
            <LoaderIcon className="task-running-icon" size={16} data-loading-indicator="true" />
          ) : r.status === "error" ? (
            <span data-error-indicator="true" className="task-error-dot" />
          ) : r.unreadAt !== undefined ? (
            <span data-unread-indicator="true" className="task-unread-dot" />
          ) : null}
        </span>
        <button
          className={`row-action task-pin ${r.pinnedAt != null && r.status !== "running" && r.status !== "error" && r.unreadAt === undefined ? "pinned" : ""}`}
          aria-label={`${r.pinnedAt != null ? "取消置顶" : "置顶"}任务 ${r.title}`}
          title={
            r.pinnedAt != null
              ? "取消置顶"
              : pinnedCount >= taskPinLimit
                ? "最多置顶 5 个任务，请先取消其他任务的置顶"
                : "置顶"
          }
          disabled={r.pinnedAt == null && pinnedCount >= taskPinLimit}
          onMouseDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
          onClick={() =>
            task(async () => {
              unwrap(await window.zpi.setSessionPinned(r.id, r.pinnedAt == null));
              await refresh();
            })
          }
        >
          <Pin size={16} />
        </button>
      </span>
      <button
        className="session-name"
        title={r.title}
        onClick={() => {
          setModelOpen(false);
          task(() => selectSession(r.id));
        }}
      >
        {r.title}
      </button>
      <button
        className="row-action task-archive"
        aria-label={`归档任务 ${r.title}`}
        title="归档"
        onClick={() =>
          task(async () => {
            unwrap(await window.zpi.archiveSession(r.id));
            await refresh();
            if (selected === r.id && r.status !== "running") {
              const next = [...useStore.getState().sessions.values()][0];
              if (next) await selectSession(next.id);
              else useStore.setState({ selected: undefined });
            }
          })
        }
      >
        <Archive size={14} />
      </button>
    </div>
  );
  const paneWidth = Math.max(
    300,
    Math.min((viewport - width) * paneRatio, viewport - width - (viewport >= 1100 ? 380 : 60)),
  );
  const recent = [...records].sort((a, b) =>
    a.pinnedAt != null && b.pinnedAt != null
      ? a.pinnedAt - b.pinnedAt
      : a.pinnedAt != null
        ? -1
        : b.pinnedAt != null
          ? 1
          : b.updatedAt - a.updatedAt,
  );
  return (
    <div
      className={`shell ${window.zpi.platform === "darwin" ? "mac-desktop" : ""} ${collapsed ? "left-collapsed" : ""} ${paneOpen ? "pane-open" : ""} ${settingsOpen ? "show-settings" : ""}`}
      style={
        { "--left-sidebar-width": `${width}px`, "--right-pane-width": `${paneWidth}px` } as CSSProperties
      }
    >
      <WindowChrome
        leftCollapsed={collapsed}
        rightOpen={paneOpen}
        hidden={settingsOpen}
        onNewTask={() => task(() => newSession())}
        onToggleLeft={() => updatePrefs({ sidebarCollapsed: !collapsed })}
        onToggleRight={() => usePane.setState({ open: !paneOpen })}
      />
      {useMemo(
        () => (
          <aside className="sidebar" hidden={collapsed} style={{ width }}>
            <div className="sidebar-global">
              <button aria-label="新建任务" onClick={() => task(() => newSession())}>
                <MessageCirclePlus size={16} />
                新建任务
              </button>
            </div>
            {!collapsed && (
              <div className="sidebar-sections">
                {recent.some((r) => r.pinnedAt != null) && (
                  <section className="pinned-tasks" aria-label="置顶任务">
                    <h3 className="sidebar-heading">置顶</h3>
                    {recent.filter((r) => r.pinnedAt != null).map(renderRow)}
                  </section>
                )}
                <div className="sidebar-heading">
                  <button
                    className="section-toggle"
                    aria-label={`${prefs?.projectsCollapsed ? "展开" : "收起"}项目列表`}
                    aria-expanded={!prefs?.projectsCollapsed}
                    onClick={() => updatePrefs({ projectsCollapsed: !prefs?.projectsCollapsed })}
                  >
                    <span>项目</span>
                    {prefs?.projectsCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <button aria-label="添加项目" className="muted-icon" onClick={() => void addProject()}>
                    <MessageCirclePlus size={14} />
                  </button>
                </div>
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
                            <Folder size={16} />
                          ) : (
                            <FolderOpen size={16} />
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
                          <Menu.Trigger
                            className="project-row-action"
                            aria-label={`项目操作 ${p.name}`}
                            title="更多"
                          >
                            <Ellipsis size={14} />
                          </Menu.Trigger>
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
                                    unwrap(await window.zpi.removeProject(p.id));
                                    await refresh();
                                  })
                                }
                              >
                                <X size={14} />
                                移除
                              </Menu.Item>
                            </Menu.Content>
                          </Menu.Portal>
                        </Menu.Root>
                        <button
                          aria-label={`新建任务 ${p.name}`}
                          title="新建任务"
                          className="project-row-action"
                          onClick={() => task(() => newSession(p.id))}
                        >
                          <MessageCirclePlus size={14} />
                        </button>
                      </div>
                      {!prefs?.collapsedProjectIds.includes(p.id) &&
                        records
                          .filter((r) => r.projectId === p.id)
                          .sort((a, b) => b.updatedAt - a.updatedAt)
                          .map(renderRow)}
                    </section>
                  ))}
                  {!state.projects.length && (
                    <div className="sidebar-empty">添加项目，按工作目录管理任务。</div>
                  )}
                </div>
                <div className="sidebar-heading">
                  <button
                    className="section-toggle"
                    aria-label={`${prefs?.tasksCollapsed ? "展开" : "收起"}任务列表`}
                    aria-expanded={!prefs?.tasksCollapsed}
                    onClick={() => updatePrefs({ tasksCollapsed: !prefs?.tasksCollapsed })}
                  >
                    <span>任务</span>
                    {prefs?.tasksCollapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
                  </button>
                  <button
                    aria-label="新建任务"
                    title="新建任务"
                    className="muted-icon"
                    onClick={() => task(() => newSession(null))}
                  >
                    <MessageCirclePlus size={14} />
                  </button>
                </div>
                <div className="recent-sessions" hidden={prefs?.tasksCollapsed}>
                  {recent.map(renderRow)}
                </div>
              </div>
            )}
            <div className="sidebar-footer">
              <button aria-label="设置" title="设置" onClick={() => setSettingsOpen(true)}>
                <Settings size={15} />
                {!collapsed && "设置"}
              </button>
            </div>
          </aside>
        ),
        [collapsed, width, records, state.projects, selected, prefs],
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
            document.body.style.userSelect = oldSelect.current;
            e.currentTarget.releasePointerCapture(e.pointerId);
            updatePrefs({ sidebarWidth: boundedWidth(e.clientX) });
            setDragWidth(undefined);
          }}
          onPointerCancel={() => {
            resizing.current = false;
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
        {state.settings?.providers.some((p) => p.hasApiKey) && !state.settings.credentialsPersisted && (
          <div className="banner">系统加密不可用，凭据仅保存在本次应用内存中。</div>
        )}
        {!state.settings?.providers.some((p) => p.models.length) && state.ready && (
          <div className="banner">先在设置中添加提供商和模型。</div>
        )}
        {view ? (
          <div className="task-body">
            <Conversation
              workspace={workspace}
              view={view}
              historyCursor={state.historyCursors.get(view.sessionId)}
              hasEarlier={state.historyCursors.get(view.sessionId) != null}
              loadingEarlier={state.historyLoading.has(view.sessionId)}
              onLoadEarlier={earlier}
              onLink={openLink}
              context={inputContext}
              onChanges={openChanges}
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
                  remove: (itemId) => window.zpi.removeQueuedInput(view.sessionId, itemId).then(unwrap),
                  sendNow: (itemId) => window.zpi.sendQueuedNow(view.sessionId, itemId).then(unwrap),
                  move: (itemId, beforeId) =>
                    window.zpi.moveQueuedInput(view.sessionId, itemId, beforeId).then(unwrap),
                  resume: () => window.zpi.resumeInputQueue(view.sessionId).then(unwrap),
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
                    const result = await window.zpi.submitInput({
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
                onStop={() => {
                  if (activeRun)
                    task(async () =>
                      unwrap(
                        await window.zpi.abortRun({ sessionId: view.sessionId, runId: activeRun.runId }),
                      ),
                    );
                }}
              />
            </div>
          </div>
        ) : (
          <div className="empty-chat" role="status">
            正在准备任务…
          </div>
        )}
      </main>
      <RightPane width={paneWidth} available={viewport - width} sessionId={selected} />
      {useMemo(
        () => (settingsOpen ? <SettingsPage onClose={() => setSettingsOpen(false)} /> : null),
        [settingsOpen],
      )}
    </div>
  );
}
