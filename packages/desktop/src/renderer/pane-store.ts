import { type FileLocation, type WebOpenOptions, webOpenTarget } from "ZPI-ui/links";
import { create } from "zustand";
import type { BrowserState, FilePreview, PaneEvent } from "../shared/bridge.ts";
import { report, unwrap } from "./store.ts";
export type PaneTab =
  | { id: string; type: "changes"; sessionId: string; runId: string | null; path?: string; title: string }
  | { id: string; type: "terminal"; title: string; sessionId: string; cwd: string }
  | { id: string; type: "file"; title: string; sessionId: string; preview: FilePreview }
  | { id: string; type: "browser"; title: string; state: BrowserState };
interface PaneState {
  open: boolean;
  tabs: PaneTab[];
  active?: string;
  ratio: number;
}
let savedRatio = 0.45;
try {
  const value = Number(localStorage.getItem("ZPI.rightPaneRatio"));
  if (value >= 0.2 && value <= 0.7) savedRatio = value;
} catch {
  /* Optional UI preference. */
}
export const usePane = create<PaneState>(() => ({ open: false, tabs: [], ratio: savedRatio }));
export const terminalOutput = new Map<string, string>();
export const terminalListeners = new Map<string, (event: Extract<PaneEvent, { type: "terminal" }>) => void>();
export function listenPanes() {
  return window.ZPI.onPaneEvent((event) => {
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
}
function showTab(tab: PaneTab) {
  const current = usePane.getState();
  usePane.setState({
    open: true,
    active: tab.id,
    tabs: current.tabs.some((item) => item.id === tab.id)
      ? current.tabs.map((item) => (item.id === tab.id ? tab : item))
      : [...current.tabs, tab],
  });
}
export function openChanges(sessionId: string, runId: string | null, path?: string) {
  const id = `changes:${sessionId}:${runId ?? "task"}`;
  showTab({ id, type: "changes", sessionId, runId, path, title: "变更" });
}
export async function openTerminal(sessionId: string) {
  const cwd = unwrap(await window.ZPI.getWorkspaceInfo(sessionId)).cwd;
  const created = unwrap(await window.ZPI.createTerminal(sessionId));
  showTab({ type: "terminal", id: created.id, title: created.shell, sessionId, cwd });
}
export async function openBrowser(url = "") {
  const created = unwrap(await window.ZPI.createBrowser(url));
  showTab({ type: "browser", id: created.id, title: "浏览器", state: created });
}
export async function openWebLink(url: string, options?: WebOpenOptions) {
  if (webOpenTarget(url, options) === "app-browser") await openBrowser(url);
  else unwrap(await window.ZPI.openExternal(url));
}
export async function openFile(sessionId: string, path: string, location?: FileLocation) {
  const preview = unwrap(await window.ZPI.readFilePreview(sessionId, path, location));
  if (preview.kind === "directory") {
    unwrap(await window.ZPI.fileAction(sessionId, preview.path, "reveal"));
    return;
  }
  if (/\.(?:html?|pdf)$/i.test(preview.path) && !location?.line) {
    await openBrowser(location?.fileUrl ?? preview.path);
    return;
  }
  const id = `file:${preview.path}`;
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
  const index = current.tabs.findIndex((item) => item.id === id);
  const tabs = current.tabs.filter((item) => item.id !== id);
  usePane.setState({
    tabs,
    open: current.open && tabs.length > 0,
    active: current.active === id ? tabs[Math.min(index, tabs.length - 1)]?.id : current.active,
  });
}
export function paneTask(task: Promise<unknown>) {
  void task.catch(report);
}
