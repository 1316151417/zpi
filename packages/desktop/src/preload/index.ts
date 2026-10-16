import { contextBridge, ipcRenderer, webUtils } from "electron";
import type { DesktopEventEnvelope } from "zpi-ui";
import type { DesktopBridge, PaneEvent } from "../shared/bridge.ts";
import type { ShortcutCommand } from "../shared/shortcuts.ts";

// Cancel Chromium's native clipboard default even for input injected through CDP.
// Composer handlers still receive synthetic ClipboardEvents with their own DataTransfer.
if (process.argv.includes("--zpi-test-isolation")) {
  for (const type of ["copy", "cut", "paste"])
    document.addEventListener(
      type,
      (event) => {
        if (event.isTrusted) event.preventDefault();
      },
      true,
    );
}

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke("zpi:call", method, args);
let beforeQuit: (() => Promise<void>) | undefined;
ipcRenderer.on("zpi:prepare-quit", async (_event, request: number) => {
  try {
    await beforeQuit?.();
    ipcRenderer.send("zpi:drafts-flushed", request, null);
  } catch (error) {
    ipcRenderer.send("zpi:drafts-flushed", request, error instanceof Error ? error.message : String(error));
  }
});
const bridge: DesktopBridge = {
  setSessionUnread: (id) => call("setSessionUnread", id),
  getTaskGroups: () => call("getTaskGroups"),
  updateTaskGroups: (command) => call("updateTaskGroups", command),
  listSubagents: (id) => call("listSubagents", id),
  saveSubagent: (input) => call("saveSubagent", input),
  deleteSubagent: (id, sessionId) => call("deleteSubagent", id, sessionId),
  setSubagentEnabled: (id, enabled, sessionId) => call("setSubagentEnabled", id, enabled, sessionId),
  stopSubagent: (parentId, agentId) => call("stopSubagent", parentId, agentId),
  stopBackgroundTask: (sessionId, taskId) => call("stopBackgroundTask", sessionId, taskId),
  readBackgroundTask: (sessionId, taskId) => call("readBackgroundTask", sessionId, taskId),
  setCapabilityEnabled: (name, enabled) => call("setCapabilityEnabled", name, enabled),
  respondToQuestion: (id, requestId, response) => call("respondToQuestion", id, requestId, response),
  snoozeQuestion: (id, requestId) => call("snoozeQuestion", id, requestId),
  closeSideChat: (id) => call("closeSideChat", id),
  createSideChat: (id) => call("createSideChat", id),
  getGitEnvironment: (id) => call("getGitEnvironment", id),
  setNewWorktree: (id, enabled, baseRef) => call("setNewWorktree", id, enabled, baseRef),
  logError: (error) => ipcRenderer.send("zpi:error", error),
  platform: process.platform,
  workspacePanelRadius:
    Number(process.argv.find((arg) => arg.startsWith("--zpi-panel-radius="))?.split("=")[1]) || 6,
  onBeforeQuit(listener) {
    beforeQuit = listener;
    return () => {
      if (beforeQuit === listener) beforeQuit = undefined;
    };
  },
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
    ipcRenderer.on("zpi:pane-event", handler);
    return () => ipcRenderer.removeListener("zpi:pane-event", handler);
  },
  getDraft: (id) => call("getDraft", id),
  saveDraft: (id, draft) => call("saveDraft", id, draft),
  getHistoryPage: (id, before) => call("getHistoryPage", id, before),
  copyText: (text) => call("copyText", text),
  copySessionPath: (id) => call("copySessionPath", id),
  printPageToPdf: (sessionId) => call("printPageToPdf", sessionId),
  savePreviewPdf: (data, suggestedName) => call("savePreviewPdf", data, suggestedName),
  getInstalledEditors: () => call("getInstalledEditors"),
  openInEditor: (id, path, editorId) => call("openInEditor", id, path, editorId),
  fileAction: (id, path, action, location) => call("fileAction", id, path, action, location),
  searchFiles: (id, q) => call("searchFiles", id, q),
  listSessionMentions: (id) => call("listSessionMentions", id),
  getWorkspaceInfo: (id) => call("getWorkspaceInfo", id),
  downloadImage: (src) => call("downloadImage", src),
  checkPreviewFiles: (id, paths) => call("checkPreviewFiles", id, paths),
  readPreviewRange: (id, path, offset, length) => call("readPreviewRange", id, path, offset, length),
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
  getChanges: (id, run, includePatch = true) => call("getChanges", id, run, includePatch),
  readPatch: (id, run, patch) => call("readPatch", id, run, patch),
  previewPrompt: () => call("previewPrompt"),
  listTools: () => call("listTools"),
  getCustomCommands: (projectId) => call("getCustomCommands", projectId),
  listSessionCustomCommands: (id) => call("listSessionCustomCommands", id),
  createCustomCommand: (input, projectId) => call("createCustomCommand", input, projectId),
  updateCustomCommand: (input, projectId) => call("updateCustomCommand", input, projectId),
  deleteCustomCommand: (input, projectId) => call("deleteCustomCommand", input, projectId),
  setCustomCommandEnabled: (input, projectId) => call("setCustomCommandEnabled", input, projectId),
  discoverCommandImports: (projectId) => call("discoverCommandImports", projectId),
  importCommands: (input, projectId) => call("importCommands", input, projectId),
  getSkillSettings: () => call("getSkillSettings"),
  readSkill: (path) => call("readSkill", path),
  setSkillEnabled: (path, enabled) => call("setSkillEnabled", path, enabled),
  listProjects: () => call("listProjects"),
  addProject: (sessionId) => call("addProject", sessionId),
  removeProject: (id) => call("removeProject", id),
  listSessions: (id) => call("listSessions", id),
  getTaskSearchChanges: (id) => call("getTaskSearchChanges", id),
  searchTasks: (query, workspaceKey) => call("searchTasks", query, workspaceKey),
  listTaskFiles: (id) => call("listTaskFiles", id),
  listRecentSessions: () => call("listRecentSessions"),
  setSessionPinned: (id, pinned) => call("setSessionPinned", id, pinned),
  createSession: (id, groupId) => call("createSession", id, groupId),
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
  updateShortcuts: (input) => call("updateShortcuts", input),
  setShortcutCapture: (capturing) => call("setShortcutCapture", capturing),
  onShortcutModifier(listener) {
    const handler = (_: Electron.IpcRendererEvent, held: boolean) => listener(held);
    ipcRenderer.on("zpi:shortcut-modifier", handler);
    return () => ipcRenderer.removeListener("zpi:shortcut-modifier", handler);
  },
  onShortcut(listener) {
    const handler = (_: Electron.IpcRendererEvent, command: ShortcutCommand) => listener(command);
    ipcRenderer.on("zpi:shortcut", handler);
    return () => ipcRenderer.removeListener("zpi:shortcut", handler);
  },
  onSettings(listener) {
    const handler = (
      _event: Electron.IpcRendererEvent,
      settings: import("../shared/bridge.ts").PublicSettings,
    ) => listener(settings);
    ipcRenderer.on("zpi:settings", handler);
    return () => ipcRenderer.removeListener("zpi:settings", handler);
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
    ipcRenderer.on("zpi:event", handler);
    return () => ipcRenderer.removeListener("zpi:event", handler);
  },
};
contextBridge.exposeInMainWorld("zpi", bridge);
