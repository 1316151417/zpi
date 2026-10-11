import type { ConversationSelection } from "ZPI-ui";
import { type FileLocation, type WebOpenOptions, webOpenTarget } from "ZPI-ui/links";
import { create } from "zustand";
import type { BrowserState, FilePreview, PaneEvent, SessionRecord } from "../shared/bridge.ts";
import {
  accept,
  addConversationSelection,
  closeSideChat,
  drafts,
  focusComposer,
  loadDraft,
  refreshSuggestions,
  report,
  retainedSessionViews,
  unwrap,
  useStore,
} from "./store.ts";
export type PaneTab =
  | { id: string; type: "side-chat"; title: string; sessionId: string; childSessionId: string }
  | {
      id: string;
      type: "changes";
      sessionId: string;
      runId: string | null;
      path?: string;
      toolCallId?: string;
      title: string;
    }
  | { id: string; type: "terminal"; title: string; sessionId: string; cwd: string }
  | { id: string; type: "file"; title: string; sessionId: string; preview: FilePreview }
  | { id: string; type: "browser"; title: string; sessionId?: string; state: BrowserState };
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
}
let savedRatio = 0.45;
try {
  const value = Number(localStorage.getItem("ZPI.rightPaneRatio"));
  if (value >= 0.2 && value <= 0.7) savedRatio = value;
} catch {
  /* Optional UI preference. */
}
export const usePane = create<PaneState>(() => ({
  open: false,
  tabs: [],
  ratio: savedRatio,
  preferences: new Map(),
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
  return tabs.filter((tab) => paneOwner(tab.sessionId) === sessionId);
}
function paneOwner(id: string | undefined) {
  return useStore.getState().sessions.get(id ?? "")?.parentSessionId ?? id;
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
export const terminalListeners = new Map<string, (event: Extract<PaneEvent, { type: "terminal" }>) => void>();
export function listenPanes() {
  restorePane();
  const offSelection = useStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) {
      for (const tab of usePane.getState().tabs) {
        const parent = state.sessions.get(paneOwner(tab.sessionId) ?? "");
        if ((!parent || parent.archivedAt != null) && tab.type === "side-chat") paneTask(closeTab(tab.id));
      }
    }
    if (state.selected !== previous.selected) restorePane();
  });
  const offEvents = window.ZPI.onPaneEvent((event) => {
    if (event.type === "terminal") {
      terminalOutput.set(event.id, ((terminalOutput.get(event.id) ?? "") + event.data).slice(-524288));
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
  const current = usePane.getState();
  const preferences = new Map(current.preferences);
  preferences.set(paneOwner(tab.sessionId), { open: true, active: tab.id });
  usePane.setState({
    preferences,
    tabs: current.tabs.some((item) => item.id === tab.id)
      ? current.tabs.map((item) => (item.id === tab.id ? tab : item))
      : [...current.tabs, tab],
  });
  // 异步打开时冻结来源任务；迟到结果只更新来源任务，不能展开或激活当前任务的侧栏。
  if (paneOwner(tab.sessionId) === useStore.getState().selected) restorePane();
}
const pendingSideChats = new Map<string, Promise<string>>();
const sideChatCounters = new Map<string, number>();
export async function loadSideChat(id: string) {
  retainedSessionViews.add(id);
  try {
    accept(unwrap(await window.ZPI.getSessionSnapshot(id)));
    await loadDraft(id);
    await refreshSuggestions(id);
  } catch (error) {
    retainedSessionViews.delete(id);
    throw error;
  }
}
export async function openSideChat(parentId: string, reference?: ConversationSelection, text?: string) {
  const state = usePane.getState();
  const active = state.tabs.find(
    (tab) => tab.id === state.active && tab.type === "side-chat" && tab.sessionId === parentId,
  );
  let childId = reference && active?.type === "side-chat" ? active.childSessionId : undefined;
  if (childId && active) {
    const snapshot = await window.ZPI.getSessionSnapshot(childId);
    if (!snapshot.ok && snapshot.error.code === "not_found") {
      await closeTab(active.id);
      childId = undefined;
    } else {
      const view = unwrap(snapshot).view;
      if (view.question) throw new Error("辅助对话正在等待你处理请求");
    }
  }
  if (!childId) {
    const pendingKey = `${parentId}:${text ?? ""}`;
    let pending = pendingSideChats.get(pendingKey);
    if (!pending) {
      pending = window.ZPI.createSideChat(parentId)
        .then(unwrap)
        .then(async (record) => {
          await loadSideChat(record.id);
          const parent = useStore.getState().sessions.get(parentId);
          if (!parent || parent.archivedAt != null) {
            await closeSideChat(record.id);
            throw new Error("主对话已关闭");
          }
          const count = sideChatCounters.get(parentId) ?? 0;
          sideChatCounters.set(parentId, count + 1);
          showTab({
            id: `side-chat:${record.id}`,
            type: "side-chat",
            title: `辅助对话 ${count + 1}`,
            sessionId: parentId,
            childSessionId: record.id,
          });
          if (text) {
            const draft = drafts.get(record.id);
            if (draft) drafts.set(record.id, { ...draft, text, selection: [text.length, text.length] });
            unwrap(await window.ZPI.submitInput({ sessionId: record.id, text }));
            if (draft) drafts.set(record.id, { ...draft, text: "", selection: [0, 0] });
          }
          return record.id;
        })
        .finally(() => pendingSideChats.delete(pendingKey));
      pendingSideChats.set(pendingKey, pending);
    }
    childId = await pending;
  } else if (active) showTab(active);
  if (reference) addConversationSelection(reference, childId);
  focusComposer(childId);
}
export function openChanges(sessionId: string, runId: string | null, path?: string, toolCallId?: string) {
  const id = `changes:${sessionId}:${runId ?? "task"}${toolCallId ? `:operation:${toolCallId}` : ""}`;
  showTab({
    id,
    type: "changes",
    sessionId,
    runId,
    path,
    toolCallId,
    title: toolCallId && path ? (path.split(/[\\/]/).at(-1) ?? "变更") : "变更",
  });
}
export async function openTerminal(sessionId: string) {
  const cwd = unwrap(await window.ZPI.getWorkspaceInfo(sessionId)).cwd;
  const created = unwrap(await window.ZPI.createTerminal(sessionId));
  showTab({ type: "terminal", id: created.id, title: created.shell, sessionId, cwd });
}
export async function openBrowser(url = "", sessionId = useStore.getState().selected) {
  const created = unwrap(await window.ZPI.createBrowser(url));
  showTab({ type: "browser", id: created.id, title: "浏览器", sessionId, state: created });
}
export async function openWebLink(
  url: string,
  options?: WebOpenOptions,
  sessionId = useStore.getState().selected,
) {
  if (webOpenTarget(url, options) === "app-browser") await openBrowser(url, sessionId);
  else unwrap(await window.ZPI.openExternal(url));
}
export async function openFile(sessionId: string, path: string, location?: FileLocation) {
  const preview = unwrap(await window.ZPI.readFilePreview(sessionId, path, location));
  if (preview.kind === "directory") {
    unwrap(await window.ZPI.fileAction(sessionId, preview.path, "reveal"));
    return;
  }
  if (/\.(?:html?|pdf)$/i.test(preview.path) && !location?.line) {
    await openBrowser(location?.fileUrl ?? preview.path, sessionId);
    return;
  }
  if (/\.pptx$/i.test(preview.path)) {
    unwrap(await window.ZPI.fileAction(sessionId, preview.path, "open"));
    return;
  }
  const id = `file:${sessionId}:${preview.path}`;
  showTab({
    id,
    type: "file",
    title: preview.path.split("/").at(-1) ?? preview.path,
    sessionId,
    preview,
  });
}
export async function closeTab(id: string) {
  const state = usePane.getState(),
    tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.type === "terminal") {
    unwrap(await window.ZPI.closeTerminal(id));
    terminalOutput.delete(id);
  }
  if (tab.type === "browser") unwrap(await window.ZPI.closeBrowser(id));
  if (tab.type === "side-chat") {
    await closeSideChat(tab.childSessionId);
  }
  const current = usePane.getState();
  const tabs = current.tabs.filter((item) => item.id !== id);
  const preferences = new Map(current.preferences);
  const owner = paneOwner(tab.sessionId);
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
