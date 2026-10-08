import { type FileLocation, type WebOpenOptions, webOpenTarget } from "ZPI-ui/links";
import { create } from "zustand";
import type { BrowserState, FilePreview, PaneEvent } from "../shared/bridge.ts";
import { report, unwrap, useStore } from "./store.ts";
export type PaneTab =
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
export function visiblePaneTabs(sessionId: string | undefined, tabs = usePane.getState().tabs) {
  return tabs.filter((tab) => tab.sessionId === sessionId);
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
  preferences.set(tab.sessionId, { open: true, active: tab.id });
  usePane.setState({
    preferences,
    tabs: current.tabs.some((item) => item.id === tab.id)
      ? current.tabs.map((item) => (item.id === tab.id ? tab : item))
      : [...current.tabs, tab],
  });
  // 异步打开时冻结来源任务；迟到结果只更新来源任务，不能展开或激活当前任务的侧栏。
  if (tab.sessionId === useStore.getState().selected) restorePane();
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
  const current = usePane.getState();
  const tabs = current.tabs.filter((item) => item.id !== id);
  const preferences = new Map(current.preferences);
  const saved = preferences.get(tab.sessionId);
  if (saved) {
    const visible = visiblePaneTabs(tab.sessionId, tabs);
    const previous = visiblePaneTabs(tab.sessionId, current.tabs);
    const index = previous.findIndex((item) => item.id === id);
    preferences.set(tab.sessionId, {
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
