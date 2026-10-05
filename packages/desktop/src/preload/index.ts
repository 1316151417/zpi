import { contextBridge, ipcRenderer } from "electron";
import type { DesktopEventEnvelope } from "zpi-ui";
import type { DesktopBridge, PaneEvent } from "../shared/bridge.ts";

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke("zpi:call", method, args);
const bridge: DesktopBridge = {
  platform: process.platform,
  onTaskNotificationClick(listener) {
    const handler = (_: Electron.IpcRendererEvent, sessionId: string) => listener(sessionId);
    ipcRenderer.on("zpi:task-notification-click", handler);
    return () => ipcRenderer.removeListener("zpi:task-notification-click", handler);
  },
  onTaskNotificationSound(listener) {
    const handler = () => listener();
    ipcRenderer.on("zpi:task-notification-sound", handler);
    return () => ipcRenderer.removeListener("zpi:task-notification-sound", handler);
  },
  archiveSession: (id) => call("archiveSession", id),
  listArchivedSessions: () => call("listArchivedSessions"),
  restoreSession: (id) => call("restoreSession", id),
  openSessionDirectory: (id) => call("openSessionDirectory", id),
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
    ipcRenderer.on("zpi:pane-event", handler);
    return () => ipcRenderer.removeListener("zpi:pane-event", handler);
  },
  getDraft: (id) => call("getDraft", id),
  saveDraft: (id, draft) => call("saveDraft", id, draft),
  getHistoryPage: (id, before) => call("getHistoryPage", id, before),
  copyText: (text) => call("copyText", text),
  fileAction: (id, path, action) => call("fileAction", id, path, action),
  searchFiles: (id, q) => call("searchFiles", id, q),
  getWorkspaceInfo: (id) => call("getWorkspaceInfo", id),
  downloadImage: (src) => call("downloadImage", src),
  readFilePreview: (id, path, location) => call("readFilePreview", id, path, location),
  importImage: (id, name, bytes) => call("importImage", id, name, bytes),
  pickImages: (id) => call("pickImages", id),
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
  abortRun: (input) => call("abortRun", input),
  getSettings: () => call("getSettings"),
  onSettings(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: import("../shared/bridge.ts").PublicSettings,
    ) => listener(settings);
    ipcRenderer.on("zpi:settings", handler);
    return () => ipcRenderer.removeListener("zpi:settings", handler);
  },
  discoverModels: (input) => call("discoverModels", input),
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
    ipcRenderer.on("zpi:event", handler);
    return () => ipcRenderer.removeListener("zpi:event", handler);
  },
};
contextBridge.exposeInMainWorld("zpi", bridge);
