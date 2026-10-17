import { contextBridge, ipcRenderer } from "electron";
import type { QuickChatBridge, QuickChatSnapshot } from "../shared/quick-chat.ts";

const call = (method: string, ...args: unknown[]) => ipcRenderer.invoke("zpi:quick-chat", method, args);
const bridge: QuickChatBridge = {
  getSnapshot: () => call("getSnapshot"),
  send: (text) => call("send", text),
  stop: () => call("stop"),
  reset: () => call("reset"),
  hide: () => call("hide"),
  copyText: (text) => call("copyText", text),
  openExternal: (url) => call("openExternal", url),
  onSnapshot(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: QuickChatSnapshot) => listener(snapshot);
    ipcRenderer.on("zpi:quick-chat-snapshot", handler);
    return () => ipcRenderer.removeListener("zpi:quick-chat-snapshot", handler);
  },
};
contextBridge.exposeInMainWorld("zpiQuickChat", bridge);
