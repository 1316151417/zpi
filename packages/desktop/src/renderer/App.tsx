import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import {
  Ellipsis,
  FileDiff,
  Folder,
  FolderOpen,
  Globe,
  Maximize2,
  MessageCirclePlus,
  Minimize2,
  Moon,
  Plus,
  Search,
  Settings,
  Sun,
  X,
} from "lucide-react";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActionHint,
  ChatComposer,
  Conversation,
  type FileAction,
  type FileLocation,
  type FileOpenOrigin,
  Notice,
  type SubagentTask,
  TaskFindBar,
  type WebOpenOptions,
} from "zpi-ui";
import { useShallow } from "zustand/react/shallow";
import type { EditUserInput, InterfacePreferences, SessionRecord } from "../shared/bridge.ts";
import { sidebarLimits, taskPinLimit } from "../shared/config.ts";
import { defaultShortcuts, formatShortcut, type ShortcutCommand } from "../shared/shortcuts.ts";
import { taskGroupFor } from "../shared/task-groups.ts";
import type { TaskSearchSnippet } from "../shared/task-search.ts";
import {
  captureWorkspaceShortcut,
  pinnedTaskShortcut,
  visiblePinnedTasks,
  workspaceShortcutBlocked,
} from "./app-shortcuts.ts";
import { selectAppState, selectTaskRecords } from "./app-state.ts";
import { inputContext } from "./composer-context.ts";
import { composerShortcutCommand } from "./composer-shortcuts.ts";
import { DirectoryMenuItems } from "./DirectoryMenuItems.tsx";
import { DraftProjectPicker } from "./DraftProjectPicker.tsx";
import { ModelPerformance } from "./ModelPerformance.tsx";
import {
  canOpenSideChat,
  listenPanes,
  openBrowser,
  openSideChat,
  openSubagent,
  openTerminal,
  openWebLink,
  paneTask,
  setPaneOpen,
  openChanges as showChanges,
  openFile as showFile,
  usePane,
  useSideChatBlocked,
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
  changeTaskGroups,
  drafts,
  focusComposer,
  initialize,
  loadEarlier,
  markSessionRead,
  newSession,
  queueActions,
  refresh,
  refreshSuggestions,
  report,
  resetSession,
  selectSession,
  subscribeEvents,
  useStore,
} from "./store.ts";
import { TaskActivity } from "./TaskActivity.tsx";
import { TaskGroups, TaskGroupToolbar, useTaskGroupExpansion } from "./TaskGroups.tsx";
import { TaskMenu } from "./TaskMenu.tsx";
import { type SearchCommand, TaskSearchDialog } from "./TaskSearchDialog.tsx";
import { TaskViewMenu } from "./TaskViewMenu.tsx";
import { expandTaskGroup } from "./task-group-expansion.ts";
import { playTaskNotificationSound } from "./task-notification-sound.ts";
import { PanelLeftClose, PanelLeftOpen, SquareTerminal } from "./task-search-icons.ts";
import { UserQuestionCard } from "./UserQuestionCard.tsx";
import { unwrap } from "./unwrap.ts";
import { useDialogDismiss } from "./use-dialog-dismiss.ts";
import { useStopOnEscape } from "./use-stop-on-escape.ts";
import { useTaskFind } from "./use-task-find.ts";
import { useWorkspace } from "./use-workspace.ts";
import { userErrorMessage } from "./user-error.ts";
import { WindowChrome } from "./WindowChrome.tsx";
import { WorkspaceEditorButton } from "./WorkspaceEditorButton.tsx";
import { WorktreeSettings } from "./WorktreeSettings.tsx";

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
  const compositionActive = useRef(false);
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
          className="modal task-rename-dialog"
          aria-label={action.title}
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
          }}
        >
          <form
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                (compositionActive.current || event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault();
            }}
            onSubmit={(event) => {
              event.preventDefault();
              if (confirming.current) return;
              confirming.current = true;
              setBusy(true);
              void action.onConfirm(value).then(onClose, (e) => {
                setError(userErrorMessage(e));
                confirming.current = false;
                setBusy(false);
              });
            }}
          >
            <Dialog.Title asChild>
              <h2>{action.title}</h2>
            </Dialog.Title>
            <input
              aria-label="名称"
              placeholder="任务名称"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onCompositionStart={() => {
                compositionActive.current = true;
              }}
              onCompositionEnd={() => {
                compositionActive.current = false;
              }}
            />
            {error && <Notice scope="input" message={error} />}
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={onClose}>
                取消
              </button>
              <button type="submit" className="primary" disabled={busy}>
                确认
              </button>
            </div>
          </form>
          <Dialog.Close className="task-rename-close" aria-label="关闭">
            <X aria-hidden="true" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
function dismissError(): void {
  useStore.setState({ error: undefined });
}
function openLink(url: string, options?: WebOpenOptions): void {
  paneTask(openWebLink(url, options));
}
function showSubagent(task: SubagentTask) {
  paneTask(openSubagent(task));
}
export function App() {
  const state = useStore(useShallow(selectAppState));
  const records = useStore(useShallow(selectTaskRecords));

  const paneOpen = usePane((s) => s.open),
    paneRatio = usePane((s) => s.ratio);
  const sideChatBlocked = useSideChatBlocked(state.selected);
  const [searchOpen, setSearchOpen] = useState(false);
  const [pendingSearch, setPendingSearch] = useState<{
    id: string;
    query: string;
    snippet?: TaskSearchSnippet;
  }>();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [taskMenuOpen, setTaskMenuOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  useEffect(() => {
    setEnvironmentOpen(false);
    setTaskMenuOpen(false);
  }, [state.selected]);
  const [action, setAction] = useState<ActionDialog>();
  const [viewport, setViewport] = useState(window.innerWidth);
  const [dragWidth, setDragWidth] = useState<number>();
  const resizing = useRef(false);
  const oldSelect = useRef("");
  const prefs = state.settings?.interface;
  const shortcuts = state.settings?.shortcuts ?? defaultShortcuts(window.zpi.platform);
  const [shortcutModifierHeld, setShortcutModifierHeld] = useState(false);
  useEffect(() => window.zpi.onShortcutModifier(setShortcutModifierHeld), []);
  const shortcutHint = (command: ShortcutCommand) =>
    shortcuts.enabled && shortcuts.bindings[command]
      ? formatShortcut(shortcuts.bindings[command], window.zpi.platform)
      : "";
  const collapsed = prefs?.sidebarCollapsed ?? false;
  const [taskPreferences, setTaskPreferences] = useState(() => {
    try {
      return readTaskPreferences(localStorage.getItem(taskPreferencesKey));
    } catch {
      return readTaskPreferences(null);
    }
  });
  const { collapsed: collapsedGroups, setCollapsed: setCollapsedGroups } = useTaskGroupExpansion(
    state.taskGroups.groups.map((group) => group.id),
    state.taskGroupsHydrated,
  );
  const [newGroupId, setNewGroupId] = useState<string>();
  const newTask = useCallback(async () => {
    const id = await newSession();
    if (!id || taskPreferences.organizeBy !== "grouped") return;
    const current = useStore.getState();
    const draft = current.sessions.get(id);
    if (current.selected !== id || !draft?.draft || draft.parentSessionId) return;
    // 普通新建也要显露组内草稿；仅响应新建操作，不覆盖用户在运行期间的手动折叠。
    const groupId = taskGroupFor(current.taskGroups, draft.id);
    setCollapsedGroups((collapsed) => expandTaskGroup(collapsed, groupId));
  }, [taskPreferences.organizeBy, setCollapsedGroups]);
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
    const refreshCommands = () => {
      const state = useStore.getState();
      for (const id of state.suggestions.keys()) {
        if (state.sessions.has(id))
          void refreshSuggestions(id, () => useStore.getState().sessions.has(id)).catch(report);
      }
    };
    window.addEventListener("zpi:commands-changed", refreshCommands);
    window.addEventListener("focus", refreshCommands);
    return () => {
      window.removeEventListener("zpi:commands-changed", refreshCommands);
      window.removeEventListener("focus", refreshCommands);
    };
  }, []);
  useEffect(() => {
    const unsubscribe = subscribeEvents();
    const offPanes = listenPanes();
    const offNotificationClick = window.zpi.onTaskNotificationClick((id) => {
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
    const offNotificationSound = window.zpi.onTaskNotificationSound(() => {
      void playTaskNotificationSound();
    });
    const offSettings = window.zpi.onSettings((settings) => {
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
    (reference: import("zpi-ui").ConversationSelection) => addConversationSelection(reference, selected),
    [selected],
  );
  const workspace = useWorkspace(selected);
  const view = state.activeView;
  const find = useTaskFind(selected, Boolean(view) && !settingsOpen && !action);
  useEffect(() => {
    if (!pendingSearch || selected !== pendingSearch.id || !view) return;
    find.start(
      pendingSearch.query,
      pendingSearch.snippet?.runId,
      pendingSearch.snippet?.matchBefore,
      pendingSearch.snippet?.matchAfter,
    );
    setPendingSearch(undefined);
  }, [pendingSearch, selected, view, find.start]);
  const openSearch = useCallback(() => setSearchOpen(true), []);
  const record = state.activeRecord;
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
    const focusedSideId =
      document.activeElement?.closest<HTMLElement>("[data-side-chat-session]")?.dataset.sideChatSession;
    if (focusedSideId) {
      const sideRun = useStore
        .getState()
        .views.get(focusedSideId)
        ?.runs.find((run) => run.status === "running");
      if (sideRun)
        paneTask(window.zpi.abortRun({ sessionId: focusedSideId, runId: sideRun.runId }).then(unwrap));
      return;
    }
    if (selected && activeRun)
      void window.zpi.abortRun({ sessionId: selected, runId: activeRun.runId }).then(unwrap).catch(report);
  }, [selected, activeRun?.runId]);
  useStopOnEscape(stop);
  const copyCode = useCallback((text: string) => window.zpi.copyText(text).then(unwrap), []);
  const openFile = useCallback(
    (path: string, location?: FileLocation, origin?: FileOpenOrigin) => {
      if (selected) paneTask(showFile(selected, path, location, origin));
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
      return window.zpi.readPatch(selected, runId, `operation:${toolCallId}`).then(unwrap);
    },
    [selected],
  );
  const fileAction = useCallback(
    (path: string, action: FileAction, location?: FileLocation) =>
      selected ? window.zpi.fileAction(selected, path, action, location).then(unwrap) : Promise.resolve(),
    [selected],
  );
  const earlier = useCallback(() => (selected ? loadEarlier(selected) : Promise.resolve()), [selected]);
  const editMessage = useCallback(
    async (runId: string, input: EditUserInput) => {
      if (!selected) throw new Error("任务未选中");
      const result = unwrap(await window.zpi.editUserMessage(selected, runId, input));
      if ("conflicts" in result) return result;
      resetSession(result);
    },
    [selected],
  );
  const forkMessage = useCallback(
    async (runId: string) => {
      if (!selected) throw new Error("任务未选中");
      const child = unwrap(await window.zpi.forkSession(selected, runId));
      await refresh();
      await selectSession(child.id);
    },
    [selected],
  );
  const addProject = async () => {
    try {
      const p = unwrap(await window.zpi.addProject(useStore.getState().selected ?? null));
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
  const pinned = visiblePinnedTasks(records);
  useEffect(() => {
    let composing = false;
    const begin = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const run = (command: ShortcutCommand) => {
      if (!shortcuts.enabled || !shortcuts.bindings[command] || workspaceShortcutBlocked(command)) return;
      if (command === "toggle-sidebar") updatePrefs({ sidebarCollapsed: !collapsed });
      else if (command === "toggle-pane") setPaneOpen(!usePane.getState().open);
      else if (command === "search") setSearchOpen(true);
      else if (command === "new-task") void newTask().catch(report);
      else if (command === "find") {
        if (find.open) find.close();
        else find.show();
      } else if (command === "task-menu" && record && !record.draft) setTaskMenuOpen(true);
      else if (command === "focus-composer" || command === "toggle-window") {
        const id = useStore.getState().selected;
        if (id) focusComposer(id, { onlyIfFocusLost: command === "toggle-window" });
      } else if (command.startsWith("pin-")) {
        const record = pinned[Number(command.slice(4)) - 1];
        if (record) {
          setModelOpen(false);
          void selectSession(record.id).catch(report);
        }
      }
    };
    const keydown = (event: KeyboardEvent) =>
      captureWorkspaceShortcut(event, window.zpi.platform, shortcuts, run, composing);
    // Capture before xterm consumes Ctrl combinations. Composer and question commands stay local.
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("compositionstart", begin, true);
    window.addEventListener("compositionend", end, true);
    const offNative = window.zpi.onShortcut(run);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("compositionstart", begin, true);
      window.removeEventListener("compositionend", end, true);
      offNative();
    };
  }, [
    shortcuts,
    collapsed,
    pinned.map((record) => record.id).join(":"),
    find.show,
    find.open,
    find.close,
    record?.id,
    record?.draft,
    newTask,
  ]);
  const unpinned = records
    .filter((r) => r.pinnedAt == null && r.archivedAt == null)
    .sort((a, b) => compareTasks(a, b, taskPreferences.sortBy));
  const projectIds = new Set(state.projects.map((p) => p.id));
  const allProjectGroupsExpanded =
    !prefs?.projectsCollapsed && state.projects.every((p) => !prefs?.collapsedProjectIds.includes(p.id));
  const toggleProjectGroupsLabel = allProjectGroupsExpanded ? "收起全部" : "展开全部";
  const tasks = unpinned.filter((r) => r.projectId === null || !projectIds.has(r.projectId));
  const pinnedCount = pinned.length;
  const renameTask = (record: SessionRecord) =>
    setAction({
      title: "重命名任务",
      value: record.title,
      onConfirm: async (name) => {
        unwrap(await window.zpi.renameSession(record.id, name));
        await refresh();
      },
    });
  const renderRow = (r: SessionRecord, variant: "default" | "timeline" = "default") => (
    <SidebarTaskRow
      key={r.id}
      record={r}
      active={selected === r.id}
      variant={variant}
      workspace={r.cwd?.replace(/\\/g, "/").split("/").filter(Boolean).at(-1) ?? "ZPI"}
      pinLimitReached={pinnedCount >= taskPinLimit}
      shortcut={
        shortcutModifierHeld
          ? pinnedTaskShortcut(
              pinned.findIndex((item) => item.id === r.id),
              shortcuts,
              window.zpi.platform,
            )
          : undefined
      }
      onSelect={() => {
        setModelOpen(false);
        task(() => selectSession(r.id));
      }}
      onPin={() =>
        task(async () => {
          unwrap(await window.zpi.setSessionPinned(r.id, r.pinnedAt == null));
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
  const darkTheme = document.documentElement.dataset.theme === "dark";
  const searchCommands: SearchCommand[] = [
    {
      id: "new-task",
      title: "新任务",
      section: "建议",
      keywords: "new task 任务 新任务",
      icon: MessageCirclePlus,
      run: newTask,
    },
    {
      id: "open-workspace",
      title: "打开工作区",
      section: "建议",
      keywords: "open workspace folder project 打开 文件夹 项目",
      icon: FolderOpen,
      run: addProject,
    },
    {
      id: "settings",
      title: "设置",
      section: "建议",
      keywords: "settings preferences 配置 设置",
      icon: Settings,
      run: () => setSettingsOpen(true),
    },
    {
      id: "sidebar",
      title: "切换侧边栏",
      section: "面板",
      keywords: "sidebar left toggle 侧栏 侧边栏",
      icon: collapsed ? PanelLeftOpen : PanelLeftClose,
      run: () => updatePrefs({ sidebarCollapsed: !collapsed }),
    },
    {
      id: "terminal",
      title: "添加终端标签",
      section: "面板",
      keywords: "terminal shell console 终端",
      icon: SquareTerminal,
      disabled: !selected,
      run: () => (selected ? openTerminal(selected) : undefined),
    },
    {
      id: "browser",
      title: "添加浏览器标签",
      section: "面板",
      keywords: "browser preview web 浏览器 预览",
      icon: Globe,
      run: () => openBrowser(),
    },
    {
      id: "review",
      title: "添加审查标签",
      section: "面板",
      keywords: "review git diff changes 文件变更",
      icon: FileDiff,
      disabled: !selected,
      run: () => {
        if (selected) showChanges(selected, null);
      },
    },
    {
      id: "theme",
      title: darkTheme ? "切换主题到浅色" : "切换主题到深色",
      section: "配置",
      keywords: "theme appearance light dark 主题 外观 浅色 深色",
      icon: darkTheme ? Sun : Moon,
      run: () => updatePrefs({ theme: darkTheme ? "light" : "dark" }),
    },
  ];
  return (
    <div
      className={`shell ${window.zpi.platform === "darwin" ? "mac-desktop" : ""} ${collapsed ? "left-collapsed" : ""} ${paneOpen ? "pane-open" : ""} ${settingsOpen ? "show-settings" : ""}`}
      style={
        {
          "--left-sidebar-width": `${width}px`,
          "--sidebar-content-width": `${boundedWidth(dragWidth ?? prefs?.sidebarWidth ?? sidebarLimits.default)}px`,
          "--right-pane-width": `${paneWidth}px`,
          "--right-pane-offset": `${paneOpen ? paneWidth : 0}px`,
          "--workspace-panel-radius": `${window.zpi.workspacePanelRadius}px`,
        } as CSSProperties
      }
    >
      {searchOpen && (
        <TaskSearchDialog
          selected={selected}
          workspaceKey={workspace?.cwd ?? record?.cwd ?? "ZPI"}
          projects={state.projects}
          commands={searchCommands}
          onClose={() => setSearchOpen(false)}
          onSelectTask={async (task, query, snippet) => {
            setSettingsOpen(false);
            setModelOpen(false);
            await selectSession(task.id);
            if (query) setPendingSearch({ id: task.id, query, snippet });
          }}
          onOpenFile={async (path) => {
            if (!selected) await newSession();
            const id = selected ?? useStore.getState().selected;
            if (id) await showFile(id, path);
          }}
        />
      )}
      <div className="workspace-surface" aria-hidden={settingsOpen} inert={settingsOpen}>
        <WindowChrome
          leftCollapsed={collapsed}
          rightOpen={paneOpen}
          hidden={settingsOpen}
          onNewTask={() => task(newTask)}
          onToggleLeft={() => updatePrefs({ sidebarCollapsed: !collapsed })}
          onToggleRight={() => setPaneOpen(!paneOpen)}
          shortcutHint={shortcutHint}
        />
        {useMemo(
          () => (
            <aside className="sidebar" hidden={collapsed} inert={collapsed}>
              <div className="sidebar-global">
                <button aria-label="新建任务" onClick={() => task(newTask)}>
                  <MessageCirclePlus size={16} />
                  <span className="sidebar-action-label">新建任务</span>
                  <span className="sidebar-action-shortcut">{shortcutHint("new-task")}</span>
                </button>
                <button aria-label="搜索" onClick={openSearch}>
                  <Search size={16} />
                  <span className="sidebar-action-label">搜索</span>
                  <span className="sidebar-action-shortcut">{shortcutHint("search")}</span>
                </button>
              </div>
              <div className="sidebar-sections">
                <div className="sidebar-task-toolbar">
                  <div className="sidebar-task-toolbar-main">
                    <TaskViewMenu value={taskPreferences} onChange={setTaskPreferences} viewOnly />
                    {taskPreferences.organizeBy === "grouped" && (
                      <TaskGroupToolbar
                        state={state.taskGroups}
                        collapsed={collapsedGroups}
                        onToggleAll={() =>
                          setCollapsedGroups(
                            state.taskGroups.groups.every((group) => !collapsedGroups.includes(group.id))
                              ? state.taskGroups.groups.map((group) => group.id)
                              : [],
                          )
                        }
                        onCreate={() =>
                          task(async () => {
                            const next = await changeTaskGroups({ type: "create" });
                            setNewGroupId(next.groups.at(-1)?.id);
                          })
                        }
                      />
                    )}
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
                  {taskPreferences.organizeBy !== "grouped" && (
                    <TaskViewMenu value={taskPreferences} onChange={setTaskPreferences} />
                  )}
                </div>
                {pinned.length > 0 && (
                  <section className="pinned-tasks" aria-label="置顶任务">
                    <h3 className="sidebar-heading">已置顶</h3>
                    {pinned.map((record) => renderRow(record))}
                  </section>
                )}
                {taskPreferences.organizeBy === "grouped" ? (
                  <TaskGroups
                    state={state.taskGroups}
                    records={records}
                    selected={selected}
                    collapsed={collapsedGroups}
                    setCollapsed={setCollapsedGroups}
                    newGroupId={newGroupId}
                    onSetup={() => setNewGroupId(undefined)}
                  />
                ) : taskPreferences.organizeBy === "chronological" ? (
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
                                            unwrap(await window.zpi.removeProject(p.id));
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
            shortcuts,
            shortcutModifierHeld,
            openSearch,
            collapsed,
            width,
            records,
            state.projects,
            selected,
            prefs,
            taskPreferences,
            projectLimits,
            state.taskGroups,
            collapsedGroups,
            newGroupId,
            newTask,
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
        <main
          className={`main ${record?.draft ? "draft-main" : ""}`}
          onPointerDownCapture={() => selected && paneTask(markSessionRead(selected))}
          onFocusCapture={() => selected && paneTask(markSessionRead(selected))}
        >
          <header className="topbar">
            <div className="topbar-title" title={taskTitle}>
              <Folder size={16} />
              <span>{taskTitle}</span>
            </div>
            {record && !record.draft && (
              <TaskMenu
                key={record.id}
                record={record}
                open={taskMenuOpen}
                onOpenChange={setTaskMenuOpen}
                onRename={() => renameTask(record)}
              />
            )}
            <div className="topbar-drag-space" aria-hidden="true" />
            {selected && <WorkspaceEditorButton sessionId={selected} />}
          </header>
          {state.settings?.providers.some((p) => p.hasApiKey || p.chatgptAccount?.connected) &&
            !state.settings.credentialsPersisted && (
              <Notice scope="config" tone="warning" message="系统加密不可用，凭据仅保存在本次应用内存中。" />
            )}
          {!state.settings?.providers.some((p) => p.models.length) && state.ready && (
            <Notice
              scope="config"
              tone="warning"
              message="先在设置中添加提供商和模型。"
              action={{ label: "去设置", onClick: () => setSettingsOpen(true) }}
            />
          )}
          {view ? (
            <div className="task-body">
              <TaskActivity
                key={view.sessionId}
                sessionId={view.sessionId}
                agents={view.subagents}
                commands={view.backgroundTasks}
              />
              <Conversation
                suggestions={state.activeSuggestions ?? []}
                onOpenSubagent={showSubagent}
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
                      window.dispatchEvent(new CustomEvent("zpi:scroll-to-run", { detail: origin })),
                    );
                  })().catch(report);
                }}
                onAddSelection={view.question ? undefined : addSelection}
                onSideChat={
                  canOpenSideChat(record) && !view.question
                    ? (reference) => paneTask(openSideChat(view.sessionId, reference))
                    : undefined
                }
                sideChatDisabled={sideChatBlocked}
                onEdit={editMessage}
                onFork={forkMessage}
                historyCursor={state.historyCursor}
                hasEarlier={state.historyCursor != null}
                loadingEarlier={state.loadingEarlier}
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
                {view.question && (
                  <UserQuestionCard
                    key={view.question.id}
                    sessionId={view.sessionId}
                    request={view.question}
                  />
                )}
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
                {!view.question && (
                  <ChatComposer
                    sessionId={view.sessionId}
                    draftStorage={drafts}
                    historyScope={record?.cwd}
                    sentMessages={view.runs
                      .filter((run) => !run.subagentNotification)
                      .map((run) => run.userMessage)}
                    header={
                      record?.draft ? (
                        <div className="draft-composer-header">
                          <DraftProjectPicker projectId={record.projectId} />
                          <WorktreeSettings
                            key={record.id}
                            record={record}
                            open={environmentOpen}
                            onOpenChange={setEnvironmentOpen}
                          />
                        </div>
                      ) : undefined
                    }
                    onFile={openFile}
                    context={inputContext}
                    busy={Boolean(activeRun)}
                    queue={view.queue}
                    queueActions={queueActions(view.sessionId)}
                    shortcutCommand={(event) =>
                      composerShortcutCommand(event, window.zpi.platform, shortcuts)
                    }
                    onSelectModel={() => setModelOpen(true)}
                    onConfigureEnvironment={() => {
                      if (record?.draft) setEnvironmentOpen(true);
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
                    onSubmit={async (text, input, { draftRevision }) => {
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
                        if (!(e instanceof Error && e.message === "selection_required"))
                          report(e, { input: view.sessionId, revision: draftRevision });
                        throw e;
                      }
                    }}
                    onStop={stop}
                  />
                )}
                {!view.question && prefs?.showModelPerformance && (
                  <ModelPerformance value={view.modelPerformance} />
                )}
              </div>
            </div>
          ) : (
            <div className="empty-chat" role="status">
              {state.ready ? "新建或选择一个任务开始对话" : "正在准备任务…"}
            </div>
          )}
        </main>
        <RightPane
          onSettings={() => setSettingsOpen(true)}
          available={viewport - width}
          sessionId={selected}
          findRequest={find.open && find.scope === "changes" ? find.request : undefined}
          onFindStateChange={find.update}
        />
      </div>
      {state.error && (
        <Notice key={state.errorVersion} scope="window" message={state.error} onDismiss={dismissError} />
      )}
      {action && <ActionModal action={action} onClose={() => setAction(undefined)} />}
      {useMemo(
        () => (settingsOpen ? <SettingsPage onClose={() => setSettingsOpen(false)} /> : null),
        [settingsOpen],
      )}
    </div>
  );
}
