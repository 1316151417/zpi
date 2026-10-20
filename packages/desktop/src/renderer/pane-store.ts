import { type BackgroundTask, type ConversationSelection, type SubagentTask, toolFile } from "zpi-ui";
import {
  type FileLocation,
  type FileOpenOrigin,
  markdownHtmlBrowserUrl,
  resolveLinkTarget,
  type WebOpenOptions,
  webOpenTarget,
} from "zpi-ui/links";
import { create } from "zustand";
import type {
  BrowserState,
  FilePreview,
  PaneEvent,
  SessionRecord,
  TerminalProfile,
} from "../shared/bridge.ts";
import {
  accept,
  addConversationSelection,
  closeSideChat,
  focusComposer,
  loadDraft,
  refreshSuggestions,
  report,
  retainedSessionViews,
  useStore,
} from "./store.ts";
import { terminalTitle } from "./terminal-presentation.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
export type PaneTab = (
  | { id: string; type: "background-task"; title: string; sessionId: string; taskId: string }
  | {
      id: string;
      type: "side-chat";
      title: string;
      sessionId: string;
      childSessionId: string;
      ordinal: number;
    }
  | { id: string; type: "side-chat-loading"; title: string; sessionId: string; ordinal: number }
  | { id: string; type: "task-directory"; title: string; sessionId: string }
  | {
      id: string;
      type: "subagent";
      title: string;
      sessionId: string;
      childSessionId: string;
    }
  | {
      id: string;
      type: "changes";
      sessionId: string;
      runId: string | null;
      path?: string;
      toolCallId?: string;
      title: string;
    }
  | { id: string; type: "terminal"; title: string; sessionId: string; cwd: string; profile?: TerminalProfile }
  | { id: string; type: "new-tab"; title: string; sessionId?: string }
  | {
      id: string;
      type: "file-manager";
      title: string;
      sessionId: string;
      cwd: string;
      workspaceName: string;
      preview?: FilePreview;
    }
  | { id: string; type: "file"; title: string; sessionId: string; preview: FilePreview }
  | { id: string; type: "browser"; title: string; sessionId?: string; state: BrowserState; fileKey?: string }
) & { ownerSessionId?: string };
interface PanePreference {
  open: boolean;
  active?: string;
}
interface PaneState {
  open: boolean;
  tabs: PaneTab[];
  active?: string;
  ratio: number;
  preferences: Map<string | undefined, PanePreference>;
  deletedSessionIds: Set<string>;
}
let savedRatio = 0.45;
try {
  const value = Number(localStorage.getItem("zpi.rightPaneRatio"));
  if (value >= 0.2 && value <= 0.7) savedRatio = value;
} catch {
  /* Optional UI preference. */
}
export const usePane = create<PaneState>(() => ({
  open: false,
  tabs: [],
  ratio: savedRatio,
  preferences: new Map(),
  deletedSessionIds: new Set(),
}));
export function useSideChatBlocked(parentId: string | undefined) {
  const childId = usePane((state) => {
    const tab = state.tabs.find(
      (tab) => tab.id === state.active && tab.type === "side-chat" && tab.sessionId === parentId,
    );
    return tab?.type === "side-chat" ? tab.childSessionId : undefined;
  });
  return useStore((state) => Boolean(state.views.get(childId ?? "")?.question));
}
export function canOpenSideChat(record: SessionRecord | undefined) {
  return Boolean(
    record && !record.draft && !record.parentSessionId && !(record.newWorktree && !record.worktree),
  );
}
export function visiblePaneTabs(sessionId: string | undefined, tabs = usePane.getState().tabs) {
  return tabs.filter((tab) => tabOwner(tab) === sessionId);
}
function paneOwner(id: string | undefined) {
  if (id === undefined) return;
  const record = useStore.getState().sessions.get(id);
  if (record) return record.parentSessionId ?? id;
  // Archived child records leave the recent list, but their retained panes can still navigate.
  return (
    usePane.getState().tabs.find((tab) => tab.sessionId === id && tab.ownerSessionId !== undefined)
      ?.ownerSessionId ?? id
  );
}
function tabOwner(tab: PaneTab) {
  return tab.ownerSessionId ?? paneOwner(tab.sessionId);
}
function ownerDeleted(id: string | undefined) {
  return id !== undefined && usePane.getState().deletedSessionIds.has(id);
}
function restorePane() {
  const sessionId = useStore.getState().selected;
  const state = usePane.getState();
  const tabs = visiblePaneTabs(sessionId, state.tabs);
  const saved = state.preferences.get(sessionId);
  usePane.setState({
    open: saved?.open ?? tabs.length > 0,
    active: tabs.find((tab) => tab.id === saved?.active)?.id ?? tabs.at(-1)?.id,
  });
}
export function setPaneOpen(open: boolean) {
  if (open && visiblePaneTabs(useStore.getState().selected).length === 0) {
    openNewPaneTab();
    return;
  }
  const state = usePane.getState();
  const preferences = new Map(state.preferences);
  preferences.set(useStore.getState().selected, { open, active: state.active });
  usePane.setState({ open, preferences });
}
export function activatePaneTab(id: string) {
  const sessionId = useStore.getState().selected;
  if (!visiblePaneTabs(sessionId).some((tab) => tab.id === id)) return;
  const state = usePane.getState();
  const preferences = new Map(state.preferences);
  preferences.set(sessionId, { open: state.open, active: id });
  usePane.setState({ active: id, preferences });
}
export function reorderPaneTab(id: string, targetId: string) {
  const state = usePane.getState();
  const visible = visiblePaneTabs(useStore.getState().selected, state.tabs);
  const source = visible.find((tab) => tab.id === id);
  if (!source || id === targetId || !visible.some((tab) => tab.id === targetId)) return;
  const reordered = visible.filter((tab) => tab.id !== id);
  reordered.splice(
    visible.findIndex((tab) => tab.id === targetId),
    0,
    source,
  );
  const ids = new Set(visible.map((tab) => tab.id));
  let index = 0;
  usePane.setState({ tabs: state.tabs.map((tab) => (ids.has(tab.id) ? (reordered[index++] ?? tab) : tab)) });
}
export const terminalOutput = new Map<string, string>();
export const terminalExited = new Set<string>();
export const terminalListeners = new Map<string, (event: Extract<PaneEvent, { type: "terminal" }>) => void>();
export function listenPanes() {
  restorePane();
  const offSelection = useStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) {
      for (const tab of usePane.getState().tabs) {
        const parent = state.sessions.get(tabOwner(tab) ?? "");
        if (
          (!parent || parent.archivedAt != null) &&
          (tab.type === "side-chat" ||
            tab.type === "side-chat-loading" ||
            tab.type === "subagent" ||
            tab.type === "task-directory" ||
            tab.type === "background-task")
        )
          paneTask(closeTab(tab.id));
      }
    }
    if (state.selected !== previous.selected) restorePane();
  });
  const offEvents = window.zpi.onPaneEvent((event) => {
    if (event.type === "terminal") {
      terminalOutput.set(event.id, ((terminalOutput.get(event.id) ?? "") + event.data).slice(-524288));
      if (event.exited) terminalExited.add(event.id);
      terminalListeners.get(event.id)?.(event);
    } else {
      const current = usePane.getState();
      usePane.setState({
        tabs: current.tabs.map((tab) =>
          tab.type === "browser" && tab.id === event.state.id
            ? { ...tab, state: event.state, title: event.state.title || "浏览器" }
            : tab,
        ),
      });
    }
  });
  return () => {
    offSelection();
    offEvents();
  };
}
function showTab(tab: PaneTab) {
  const ownerSessionId = tabOwner(tab);
  if (ownerDeleted(ownerSessionId)) return;
  // Archival removes child records from the session list; retain their original owner.
  tab = { ...tab, ownerSessionId };
  const current = usePane.getState();
  const preferences = new Map(current.preferences);
  preferences.set(ownerSessionId, { open: true, active: tab.id });
  const launcher = current.tabs.find(
    (item) =>
      item.id === current.preferences.get(ownerSessionId)?.active &&
      item.type === "new-tab" &&
      tabOwner(item) === ownerSessionId,
  );
  const existing = current.tabs.some((item) => item.id === tab.id);
  const replaceLauncher = launcher && tab.type !== "new-tab";
  const tabs = replaceLauncher
    ? existing
      ? current.tabs
          .filter((item) => item.id !== launcher.id)
          .map((item) => (item.id === tab.id ? tab : item))
      : current.tabs.map((item) => (item.id === launcher.id ? tab : item))
    : existing
      ? current.tabs.map((item) => (item.id === tab.id ? tab : item))
      : [...current.tabs, tab];
  usePane.setState({ preferences, tabs });
  // 异步打开时冻结来源任务；迟到结果只更新来源任务，不能展开或激活当前任务的侧栏。
  if (ownerSessionId === useStore.getState().selected) restorePane();
}
const pendingSideChats = new Map<string, { tabId: string; promise: Promise<string | undefined> }>();
let sideChatRequest = 0;
export async function loadSideChat(id: string, current = () => true) {
  retainedSessionViews.add(id);
  try {
    // Draft readiness is required before mounting the editor; optional suggestions are not.
    const [snapshot, draft] = await Promise.allSettled([
      window.zpi.getSessionSnapshot(id).then(unwrap),
      loadDraft(id),
    ]);
    if (!current()) return;
    if (snapshot.status === "rejected") throw snapshot.reason;
    if (draft.status === "rejected") throw draft.reason;
    accept(snapshot.value);
    const retained = () => retainedSessionViews.has(id) && current();
    void refreshSuggestions(id, retained).catch((error) => {
      if (retained()) report(error);
    });
  } catch (error) {
    retainedSessionViews.delete(id);
    throw error;
  }
}
export async function openSideChat(parentId: string, reference?: ConversationSelection) {
  const focusOrigin = document.activeElement;
  const state = usePane.getState();
  const active = state.tabs.find(
    (tab) => tab.id === state.active && tab.type === "side-chat" && tab.sessionId === parentId,
  );
  let childId = reference && active?.type === "side-chat" ? active.childSessionId : undefined;
  if (childId && active) {
    showTab(active);
    const snapshot = await window.zpi.getSessionSnapshot(childId);
    if (
      !usePane
        .getState()
        .tabs.some(
          (tab) => tab.id === active.id && tab.type === "side-chat" && tab.childSessionId === childId,
        )
    )
      return;
    if (!snapshot.ok && snapshot.error.code === "not_found") {
      await closeTab(active.id);
      childId = undefined;
    } else {
      const view = unwrap(snapshot).view;
      if (view.question) throw new Error("辅助对话正在等待你处理请求");
    }
  }
  if (!childId) {
    let pending = pendingSideChats.get(parentId);
    if (!pending) {
      const used = new Set(
        visiblePaneTabs(parentId).flatMap((tab) =>
          tab.type === "side-chat" || tab.type === "side-chat-loading" ? [tab.ordinal] : [],
        ),
      );
      let ordinal = 1;
      while (used.has(ordinal)) ordinal++;
      const tabId = `side-chat:request:${++sideChatRequest}`;
      const tab = {
        id: tabId,
        type: "side-chat-loading" as const,
        title: `辅助对话 ${ordinal}`,
        ordinal,
        sessionId: parentId,
      };
      showTab(tab);
      const current = () => usePane.getState().tabs.some((item) => item.id === tabId);
      const promise = (async () => {
        let created: string | undefined;
        try {
          const record = unwrap(await window.zpi.createSideChat(parentId));
          created = record.id;
          if (current()) await loadSideChat(record.id, current);
          const parent = useStore.getState().sessions.get(parentId);
          if (!current() || !parent || parent.archivedAt != null || ownerDeleted(parentId)) {
            await closeSideChat(record.id);
            await closeTab(tabId);
            return;
          }
          // Replace in place: completion must not reopen a collapsed pane or change the active tab.
          usePane.setState((state) => ({
            tabs: state.tabs.map((item) =>
              item.id === tabId && item.type === "side-chat-loading"
                ? { ...item, type: "side-chat", childSessionId: record.id }
                : item,
            ),
          }));
          return record.id;
        } catch (error) {
          if (created) await closeSideChat(created).catch(report);
          const stillOpen = current();
          await closeTab(tabId);
          if (stillOpen) throw error;
        } finally {
          if (pendingSideChats.get(parentId)?.tabId === tabId) pendingSideChats.delete(parentId);
        }
      })();
      pending = { tabId, promise };
      pendingSideChats.set(parentId, pending);
    }
    childId = await pending.promise;
  }
  if (!childId) return;
  const pane = usePane.getState();
  const tab = pane.tabs.find((tab) => tab.type === "side-chat" && tab.childSessionId === childId);
  if (!tab) return;
  if (reference) addConversationSelection(reference, childId, false);
  if (pane.open && pane.active === tab.id && useStore.getState().selected === parentId)
    focusComposer(childId, {
      onlyIfFocusLost:
        document.activeElement !== focusOrigin ||
        Boolean(focusOrigin?.matches('input, textarea, [contenteditable="true"]')),
    });
}
export async function openSubagent(task: SubagentTask) {
  const retained = retainedSessionViews.has(task.childSessionId);
  retainedSessionViews.add(task.childSessionId);
  try {
    accept(unwrap(await window.zpi.getSessionSnapshot(task.childSessionId)));
    showTab({
      id: `subagent:${task.childSessionId}`,
      type: "subagent",
      title: task.description,
      sessionId: task.parentSessionId,
      childSessionId: task.childSessionId,
    });
  } catch (error) {
    if (!retained) retainedSessionViews.delete(task.childSessionId);
    throw error;
  }
}
export function openNewPaneTab() {
  showTab({
    id: `new-tab:${crypto.randomUUID()}`,
    type: "new-tab",
    title: "新标签页",
    sessionId: useStore.getState().selected,
  });
}
export async function openFileManager(sessionId: string) {
  const ownerSessionId = paneOwner(sessionId);
  const workspace = unwrap(await window.zpi.getWorkspaceInfo(sessionId));
  if (ownerDeleted(ownerSessionId)) return;
  showTab({
    id: `file-manager:${crypto.randomUUID()}`,
    type: "file-manager",
    title: "文件",
    sessionId,
    ownerSessionId,
    cwd: workspace.cwd,
    workspaceName: workspace.projectId
      ? workspace.projectName
      : workspace.cwd.split(/[\\/]/).at(-1) || "Workspace",
  });
}
const fileManagerRequests = new Map<string, number>();
let fileManagerVersion = 0;
export async function navigateFileManager(tabId: string, path: string) {
  const tab = usePane.getState().tabs.find((tab) => tab.id === tabId);
  if (tab?.type !== "file-manager") return;
  const version = ++fileManagerVersion;
  fileManagerRequests.set(tabId, version);
  try {
    const result = await window.zpi.readFilePreview(tab.sessionId, path);
    if (fileManagerRequests.get(tabId) !== version || ownerDeleted(tabOwner(tab))) return;
    const preview = unwrap(result);
    // Navigation updates this instance without activating a tab or changing task ownership.
    usePane.setState((state) => ({
      tabs: state.tabs.map((item) =>
        item.id === tabId && item.type === "file-manager"
          ? { ...item, preview, title: preview.path.split(/[\\/]/).at(-1) || "文件" }
          : item,
      ),
    }));
  } finally {
    if (fileManagerRequests.get(tabId) === version) fileManagerRequests.delete(tabId);
  }
}
export function openChanges(sessionId: string, runId: string | null, path?: string, toolCallId?: string) {
  path ||= undefined;
  toolCallId ||= undefined;
  // 文件名不能只用于标题：同轮的不同文件必须独立，旧内存页签按来源字段继续复用。
  const existing = usePane
    .getState()
    .tabs.find(
      (tab) =>
        tab.type === "changes" &&
        tab.sessionId === sessionId &&
        tab.runId === runId &&
        (tab.path || undefined) === path &&
        (tab.toolCallId || undefined) === toolCallId,
    );
  const id =
    existing?.id ?? `changes:${JSON.stringify([sessionId, runId, toolCallId ?? null, path ?? null])}`;
  showTab({
    id,
    type: "changes",
    sessionId,
    runId,
    path,
    toolCallId,
    title: path ? (path.split(/[\\/]/).at(-1) ?? "变更") : "变更",
  });
}
export async function openTerminal(sessionId: string) {
  const ownerSessionId = paneOwner(sessionId);
  const cwd = unwrap(await window.zpi.getWorkspaceInfo(sessionId)).cwd;
  if (ownerDeleted(ownerSessionId)) return;
  const created = unwrap(await window.zpi.createTerminal(sessionId));
  if (ownerDeleted(ownerSessionId)) {
    unwrap(await window.zpi.closeTerminal(created.id));
    terminalOutput.delete(created.id);
    return;
  }
  const title = terminalTitle(
    cwd,
    usePane
      .getState()
      .tabs.filter((tab) => tab.type === "terminal" && tabOwner(tab) === ownerSessionId)
      .map((tab) => tab.title),
  );
  showTab({
    type: "terminal",
    id: created.id,
    title,
    sessionId,
    ownerSessionId,
    cwd,
    profile: created.profile,
  });
}
export async function openBrowser(
  url = "",
  sessionId = useStore.getState().selected,
  ownerSessionId = paneOwner(sessionId),
) {
  if (ownerDeleted(ownerSessionId)) return;
  const created = unwrap(await window.zpi.createBrowser(url));
  if (ownerDeleted(ownerSessionId)) {
    unwrap(await window.zpi.closeBrowser(created.id));
    return;
  }
  showTab({ type: "browser", id: created.id, title: "浏览器", sessionId, ownerSessionId, state: created });
}
export async function openWebLink(
  url: string,
  options?: WebOpenOptions,
  sessionId = useStore.getState().selected,
) {
  if (webOpenTarget(url, options) === "app-browser") await openBrowser(url, sessionId);
  else unwrap(await window.zpi.openExternal(url));
}
const fileOpenVersions = new Map<string, number>();
let fileOpenVersion = 0;
let pendingFileReads = 0;
export async function openFile(
  sessionId: string,
  path: string,
  location?: FileLocation,
  origin?: FileOpenOrigin,
) {
  const ownerSessionId = paneOwner(sessionId);
  const state = useStore.getState();
  const cwd = state.sessions.get(sessionId)?.cwd;
  const target = resolveLinkTarget(path, { cwd });
  // Streamed write/edit parameters are a preview, not a file that already exists on disk.
  for (const run of state.views.get(sessionId)?.runs ?? []) {
    if (run.status !== "running") continue;
    for (const block of run.orderedBlocks) {
      if (
        block.type !== "tool" ||
        !["write", "edit"].includes(block.name) ||
        !["preparing", "running"].includes(block.status)
      )
        continue;
      const file = toolFile(block);
      const pending = file && resolveLinkTarget(file.path, { cwd });
      if (
        file &&
        (file.path === path ||
          (target?.kind === "file" && pending?.kind === "file" && target.path === pending.path))
      ) {
        openChanges(sessionId, run.runId, file.path, block.toolCallId);
        return;
      }
    }
  }
  const requestKey = `file:${sessionId}:${target?.kind === "file" ? target.path : path}`;
  const version = ++fileOpenVersion;
  fileOpenVersions.set(requestKey, version);
  pendingFileReads++;
  try {
    const result = await window.zpi.readFilePreview(sessionId, path, location);
    if (ownerDeleted(ownerSessionId) || fileOpenVersions.get(requestKey) !== version) return;
    const preview = unwrap(result);
    const id = `file:${sessionId}:${preview.path}`;
    // 相对路径和符号链接可能指向同一标签；较旧的读取或关闭前的刷新不得重新提交。
    if ((fileOpenVersions.get(id) ?? 0) > version) return;
    fileOpenVersions.set(id, version);
    if (preview.kind === "directory") {
      unwrap(await window.zpi.fileAction(sessionId, preview.path, "reveal"));
      return;
    }
    const url = markdownHtmlBrowserUrl(
      preview.path,
      preview.location ?? location ?? (target?.kind === "file" ? target : undefined),
      origin,
    );
    if (url) {
      const existing = usePane
        .getState()
        .tabs.find(
          (tab): tab is Extract<PaneTab, { type: "browser" }> =>
            tab.type === "browser" && tab.sessionId === sessionId && tab.state.url === url,
        );
      if (existing) {
        showTab({ ...existing, fileKey: id });
        return;
      }
      const created = unwrap(await window.zpi.createBrowser(url));
      if (
        ownerDeleted(ownerSessionId) ||
        fileOpenVersions.get(id) !== version ||
        fileOpenVersions.get(requestKey) !== version
      ) {
        unwrap(await window.zpi.closeBrowser(created.id));
        return;
      }
      showTab({
        type: "browser",
        id: created.id,
        title: "浏览器",
        sessionId,
        ownerSessionId,
        state: created,
        fileKey: id,
      });
      return;
    }
    showTab({
      id,
      type: "file",
      title: preview.path.split("/").at(-1) ?? preview.path,
      sessionId,
      ownerSessionId,
      preview,
    });
  } finally {
    // 仅在读取未结束时保留版本，避免已关闭文件永久占用状态。
    if (--pendingFileReads === 0) fileOpenVersions.clear();
  }
}
/** Only a successful explicit deletion proves that retained native panes must be closed. */
export async function deleteSessionWithPanes(sessionId: string) {
  unwrap(await window.zpi.deleteSession(sessionId));
  const state = usePane.getState();
  usePane.setState({ deletedSessionIds: new Set(state.deletedSessionIds).add(sessionId) });
  await Promise.all(
    state.tabs
      .filter((tab) => tabOwner(tab) === sessionId)
      .map((tab) =>
        closeTab(tab.id).catch((error) =>
          report(new Error(`任务已删除，但侧栏清理失败：${userErrorMessage(error)}`, { cause: error })),
        ),
      ),
  );
  const preferences = new Map(usePane.getState().preferences);
  preferences.delete(sessionId);
  usePane.setState({ preferences });
}
export async function closeTab(id: string) {
  const state = usePane.getState(),
    tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  fileManagerRequests.delete(id);
  if (tab.type === "side-chat-loading" && pendingSideChats.get(tab.sessionId)?.tabId === id)
    pendingSideChats.delete(tab.sessionId);
  if (pendingFileReads) {
    if (tab.type === "file") fileOpenVersions.set(id, ++fileOpenVersion);
    if (tab.type === "browser" && tab.fileKey) fileOpenVersions.set(tab.fileKey, ++fileOpenVersion);
  }
  if (tab.type === "terminal") {
    unwrap(await window.zpi.closeTerminal(id));
    terminalOutput.delete(id);
    terminalExited.delete(id);
  }
  if (tab.type === "browser") unwrap(await window.zpi.closeBrowser(id));
  if (tab.type === "subagent") retainedSessionViews.delete(tab.childSessionId);
  if (tab.type === "side-chat") {
    await closeSideChat(tab.childSessionId);
  }
  const current = usePane.getState();
  const tabs = current.tabs.filter((item) => item.id !== id);
  const preferences = new Map(current.preferences);
  const owner = tabOwner(tab);
  const saved = preferences.get(owner);
  if (saved) {
    const visible = visiblePaneTabs(owner, tabs);
    const previous = visiblePaneTabs(owner, current.tabs);
    const index = previous.findIndex((item) => item.id === id);
    preferences.set(owner, {
      open: saved.open && visible.length > 0,
      active: saved.active === id ? visible[Math.min(index, visible.length - 1)]?.id : saved.active,
    });
  }
  usePane.setState({ tabs, preferences });
  restorePane();
}
export function paneTask(task: Promise<unknown>) {
  void task.catch(report);
}

export function openTaskDirectory(sessionId: string) {
  showTab({ id: `tasks:${sessionId}`, type: "task-directory", title: "任务目录", sessionId });
}
export function openBackgroundTask(task: BackgroundTask) {
  showTab({
    id: task.taskId,
    type: "background-task",
    title: task.description,
    sessionId: task.sessionId,
    taskId: task.taskId,
  });
}
