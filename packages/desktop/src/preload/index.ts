import type { DesktopEventEnvelope } from "ZPI-ui";
import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopBridge, PaneEvent } from "../shared/bridge.ts";

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke("ZPI:call", method, args);
let beforeQuit: (() => Promise<void>) | undefined;
ipcRenderer.on("ZPI:prepare-quit", async (_event, request: number) => {
  try {
    await beforeQuit?.();
    ipcRenderer.send("ZPI:drafts-flushed", request, null);
  } catch (error) {
    ipcRenderer.send("ZPI:drafts-flushed", request, error instanceof Error ? error.message : String(error));
  }
});
const bridge: DesktopBridge = {
  logError: (error) => ipcRenderer.send("ZPI:error", error),
  platform: process.platform,
  onBeforeQuit(listener) {
    beforeQuit = listener;
    return () => {
      if (beforeQuit === listener) beforeQuit = undefined;
    };
  },
  onTaskNotificationClick(listener) {
    const handler = (_: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on("ZPI:task-notification-click", handler);
    return () => ipcRenderer.removeListener("ZPI:task-notification-click", handler);
  },
  onTaskNotificationSound(listener) {
    const handler = () => listener();
    ipcRenderer.on("ZPI:task-notification-sound", handler);
    return () => ipcRenderer.removeListener("ZPI:task-notification-sound", handler);
  },
  archiveSession: (id) => call("archiveSession", id),
  listArchivedSessions: () => call("listArchivedSessions"),
  restoreSession: (id) => call("restoreSession", id),
  openDirectory: (path) => call("openDirectory", path),
  activateSession: (id) => call("activateSession", id),
  createTerminal: (id) => call("createTerminal", id),
  terminalInput: (id, data) => call("terminalInput", id, data),
  resizeTerminal: (id, cols, rows) => call("resizeTerminal", id, cols, rows),
  closeTerminal: (id) => call("closeTerminal", id),
  createBrowser: (url) => call("createBrowser", url),
  browserAction: (id, action, url) => call("browserAction", id, action, url),
  browserBounds: (id, bounds) => call("browserBounds", id, bounds),
  closeBrowser: (id) => call("closeBrowser", id),
  onPaneEvent(listener) {
    const handler = (_: Electron.IpcRendererEvent, event: PaneEvent) => listener(event);
    ipcRenderer.on("ZPI:pane-event", handler);
    return () => ipcRenderer.removeListener("ZPI:pane-event", handler);
  },
  getDraft: (id) => call("getDraft", id),
  saveDraft: (id, draft) => call("saveDraft", id, draft),
  getHistoryPage: (id, before) => call("getHistoryPage", id, before),
  copyText: (text) => call("copyText", text),
  fileAction: (id, path, action, location) => call("fileAction", id, path, action, location),
  searchFiles: (id, q) => call("searchFiles", id, q),
  getWorkspaceInfo: (id) => call("getWorkspaceInfo", id),
  downloadImage: (src) => call("downloadImage", src),
  checkPreviewFiles: (id, paths) => call("checkPreviewFiles", id, paths),
  readFilePreview: (id, path, location) => call("readFilePreview", id, path, location),
  pickAttachments: (id) => call("pickAttachments", id),
  importAttachment: async (id, file) => {
    const path = webUtils.getPathForFile(file);
    if (path) return call("importAttachment", id, path);
    if (file.size > 20 * 1024 * 1024) throw new Error("附件导入参数无效（最多 20 MiB）");
    return call("importAttachment", id, { name: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
  },
  readAttachment: (id, image) => call("readAttachment", id, image),
  removeAttachment: (id, image) => call("removeAttachment", id, image),
  getChanges: (id, run) => call("getChanges", id, run),
  readPatch: (id, run, patch) => call("readPatch", id, run, patch),
  previewPrompt: () => call("previewPrompt"),
  listTools: () => call("listTools"),
  getSkillSettings: () => call("getSkillSettings"),
  readSkill: (path) => call("readSkill", path),
  setSkillEnabled: (path, enabled) => call("setSkillEnabled", path, enabled),
  listProjects: () => call("listProjects"),
  addProject: () => call("addProject"),
  removeProject: (id) => call("removeProject", id),
  listSessions: (id) => call("listSessions", id),
  listRecentSessions: () => call("listRecentSessions"),
  setSessionPinned: (id, pinned) => call("setSessionPinned", id, pinned),
  createSession: (id) => call("createSession", id),
  getSessionSnapshot: (id) => call("getSessionSnapshot", id),
  renameSession: (id, name) => call("renameSession", id, name),
  deleteSession: (id) => call("deleteSession", id),
  startRun: (input) => call("startRun", input),
  submitInput: (input) => call("submitInput", input),
  editQueuedInput: (id, itemId) => call("editQueuedInput", id, itemId),
  removeQueuedInput: (id, itemId) => call("removeQueuedInput", id, itemId),
  sendQueuedNow: (id, itemId) => call("sendQueuedNow", id, itemId),
  moveQueuedInput: (id, itemId, beforeId) => call("moveQueuedInput", id, itemId, beforeId),
  resumeInputQueue: (id) => call("resumeInputQueue", id),
  forkSession: (id, runId) => call("forkSession", id, runId),
  editUserMessage: (id, runId, input) => call("editUserMessage", id, runId, input),
  abortRun: (input) => call("abortRun", input),
  getSettings: () => call("getSettings"),
  onSettings(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: import("../shared/bridge.ts").PublicSettings,
    ) => listener(settings);
    ipcRenderer.on("ZPI:settings", handler);
    return () => ipcRenderer.removeListener("ZPI:settings", handler);
  },
  discoverModels: (input) => call("discoverModels", input),
  beginChatGPTLogin: (providerId) => call("beginChatGPTLogin", providerId),
  completeChatGPTLogin: (loginId) => call("completeChatGPTLogin", loginId),
  submitChatGPTCallback: (loginId, url) => call("submitChatGPTCallback", loginId, url),
  cancelChatGPTLogin: (loginId) => call("cancelChatGPTLogin", loginId),
  disconnectChatGPT: (providerId) => call("disconnectChatGPT", providerId),
  saveProvider: (input) => call("saveProvider", input),
  reorderProviders: (ids) => call("reorderProviders", ids),
  deleteProvider: (id) => call("deleteProvider", id),
  getProviderCredentials: (id) => call("getProviderCredentials", id),
  updatePreferences: (input) => call("updatePreferences", input),
  setSessionSelection: (id, selection) => call("setSessionSelection", id, selection),
  listSessionSkills: (id) => call("listSessionSkills", id),
  listCommands: () => call("listCommands"),
  openExternal: (url) => call("openExternal", url),
  onEvent(listener) {
    const handler = (_: Electron.IpcRendererEvent, event: DesktopEventEnvelope) => listener(event);
    ipcRenderer.on("ZPI:event", handler);
    return () => ipcRenderer.removeListener("ZPI:event", handler);
  },
};
contextBridge.exposeInMainWorld("ZPI", bridge);
