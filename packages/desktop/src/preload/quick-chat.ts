import { contextBridge, ipcRenderer } from "electron";
import { imageLimits } from "zpi-coding-agent/input";
import type { QuickChatBridge, QuickChatSnapshot } from "../shared/quick-chat.ts";

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke("zpi:quick-chat", method, args);
const bridge: QuickChatBridge = {
  takeDraftInput: (sessionId) => call("takeDraftInput", sessionId),
  onDraftInput(listener) {
    const handler = () => listener();
    ipcRenderer.on("zpi:quick-chat-draft", handler);
    return () => ipcRenderer.removeListener("zpi:quick-chat-draft", handler);
  },
  getSnapshot: () => call("getSnapshot"),
  send: (text, attachments) =>
    attachments === undefined ? call("send", text) : call("send", text, attachments),
  async importAttachment(sessionId, file) {
    if (!file?.size || file.size > imageLimits.sourceBytes)
      return { ok: false, error: { code: "invalid_input", message: "图片单张上限为 10 MiB" } };
    return call("importAttachment", sessionId, file.name, new Uint8Array(await file.arrayBuffer()));
  },
  readAttachment: (sessionId, id) => call("readAttachment", sessionId, id),
  removeAttachment: (sessionId, id) => call("removeAttachment", sessionId, id),
  stop: () => call("stop"),
  reset: () => call("reset"),
  hide: () => call("hide"),
  setComposerHeight: (sessionId, height) => call("setComposerHeight", sessionId, height),
  setNoticeHeight: (sessionId, height) => call("setNoticeHeight", sessionId, height),
  rendererReady: (sessionId, version) => call("rendererReady", sessionId, version),
  rendererCommitted: (sessionId, version) =>
    process.argv.includes("--zpi-quick-chat-timing")
      ? call("rendererCommitted", sessionId, version)
      : Promise.resolve({ ok: true, value: undefined }),
  reportComposerState: (token, sessionId, occupied) =>
    call("reportComposerState", token, sessionId, occupied),
  onComposerProbe(listener) {
    const handler = (_event: Electron.IpcRendererEvent, token: number, sessionId: string) =>
      listener(token, sessionId);
    ipcRenderer.on("zpi:quick-chat-composer", handler);
    return () => ipcRenderer.removeListener("zpi:quick-chat-composer", handler);
  },
  reportPresentation: (token, stage) => call("reportPresentation", token, stage),
  onPresentation(listener) {
    const handler = (_event: Electron.IpcRendererEvent, token: number) => listener(token);
    ipcRenderer.on("zpi:quick-chat-presentation", handler);
    return () => ipcRenderer.removeListener("zpi:quick-chat-presentation", handler);
  },
  copyText: (text) => call("copyText", text),
  openExternal: (url) => call("openExternal", url),
  readWebSourceIcon: (sessionId, runId, sourceUrl) => call("readWebSourceIcon", sessionId, runId, sourceUrl),
  onSnapshot(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: QuickChatSnapshot) => listener(snapshot);
    ipcRenderer.on("zpi:quick-chat-snapshot", handler);
    return () => ipcRenderer.removeListener("zpi:quick-chat-snapshot", handler);
  },
};
contextBridge.exposeInMainWorld("zpiQuickChat", bridge);
