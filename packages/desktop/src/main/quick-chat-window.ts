import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from "electron";
import type { ErrorCode, Result } from "../shared/bridge.ts";
import { loadRenderer } from "./load-renderer.ts";
import { isPathInside } from "./path-bounds.ts";
import type { QuickChatHost } from "./quick-chat-host.ts";

interface Options {
  host: QuickChatHost;
  createWindow: (options: BrowserWindowConstructorOptions) => BrowserWindow;
  rendererUrl: string;
  preload: string;
  hiddenTestMode: boolean;
  copyText: (text: string) => void;
  openExternal: (url: string) => Promise<void>;
}
/** Lazy floating window. Hiding never touches the run, and renderer reloads recover from the host. */
export class QuickChatWindow {
  private options: Options;
  private window?: BrowserWindow;
  private loading?: Promise<void>;
  private visible = false;
  private disposed = false;
  private unsubscribe: () => void;
  constructor(options: Options) {
    this.options = options;
    this.unsubscribe = options.host.subscribe((snapshot) => {
      const window = this.window;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("zpi:quick-chat-snapshot", snapshot);
    });
  }
  owns(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">): boolean {
    const window = this.window;
    return Boolean(
      window &&
        !window.isDestroyed() &&
        !window.webContents.isDestroyed() &&
        event.sender === window.webContents &&
        event.senderFrame === window.webContents.mainFrame,
    );
  }
  private async ready(): Promise<BrowserWindow | undefined> {
    if (this.disposed) return;
    if (this.loading) {
      await this.loading;
      return this.window;
    }
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = this.options.createWindow({
      width: 660,
      height: 560,
      minWidth: 440,
      minHeight: 360,
      title: "快速对话",
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      backgroundColor: "#f8f8f8",
      webPreferences: {
        preload: this.options.preload,
        partition: "zpi-quick-chat",
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
        backgroundThrottling: false,
      },
    });
    this.window = window;
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    window.webContents.on("will-navigate", (event) => event.preventDefault());
    window.webContents.on("will-redirect", (event) => event.preventDefault());
    const session = window.webContents.session;
    session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    session.setPermissionCheckHandler(() => false);
    session.on("will-download", (event) => event.preventDefault());
    // Images/links in untrusted model output must not silently contact remote hosts.
    const renderer = new URL(this.options.rendererUrl);
    session.webRequest.onBeforeRequest((details, callback) => {
      try {
        const url = new URL(details.url);
        const localFile =
          renderer.protocol === "file:" &&
          url.protocol === "file:" &&
          isPathInside(dirname(fileURLToPath(renderer)), fileURLToPath(url));
        const local =
          localFile ||
          url.protocol === "data:" ||
          url.protocol === "blob:" ||
          (renderer.protocol !== "file:" && url.origin === renderer.origin);
        callback({ cancel: !local });
      } catch {
        callback({ cancel: true });
      }
    });
    window.on("close", (event) => {
      if (this.disposed) return;
      event.preventDefault();
      this.hide();
    });
    window.on("hide", () => {
      this.visible = false;
    });
    window.on("closed", () => {
      if (this.window === window) this.window = undefined;
      this.visible = false;
    });
    window.webContents.on("render-process-gone", () => {
      if (!window.isDestroyed()) window.destroy();
    });
    const url = new URL(this.options.rendererUrl);
    url.searchParams.set("view", "quick-chat");
    this.loading = loadRenderer(window, url.href)
      .catch((error: unknown) => {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      })
      .finally(() => {
        this.loading = undefined;
      });
    await this.loading;
    return this.window;
  }
  async show(): Promise<void> {
    if (this.disposed) return;
    this.visible = true;
    const window = await this.ready();
    if (!this.visible || this.disposed || !window || window.isDestroyed()) return;
    this.options.host.refreshSettings();
    if (!this.options.hiddenTestMode) {
      if (window.isMinimized()) window.restore();
      window.show();
      window.focus();
    }
  }
  async toggle(): Promise<void> {
    if (this.visible) this.hide();
    else await this.show();
  }
  hide(): void {
    this.visible = false;
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }
  async call(method: unknown, args: unknown): Promise<Result<unknown>> {
    try {
      if (this.disposed) throw new Error("busy: 快速对话正在关闭");
      if (typeof method !== "string" || !Array.isArray(args)) throw new Error("invalid_input: 未知 IPC 方法");
      const counts: Record<string, number> = {
        getSnapshot: 0,
        send: 1,
        stop: 0,
        reset: 0,
        setSelection: 1,
        hide: 0,
        copyText: 1,
        openExternal: 1,
      };
      if (!Object.hasOwn(counts, method) || args.length !== counts[method])
        throw new Error("invalid_input: 未知 IPC 方法或参数数量");
      const text = (limit: number) => {
        if (typeof args[0] !== "string" || args[0].length > limit)
          throw new Error("invalid_input: 文本参数无效");
        return args[0];
      };
      const host = this.options.host;
      let value: unknown;
      switch (method) {
        case "getSnapshot":
          value = host.getSnapshot();
          break;
        case "send":
          host.send(text(32_000));
          break;
        case "stop":
          await host.stop();
          break;
        case "reset":
          await host.reset();
          break;
        case "setSelection":
          host.setSelection(args[0]);
          break;
        case "hide":
          this.hide();
          break;
        case "copyText":
          this.options.copyText(text(1_000_000));
          break;
        case "openExternal": {
          const url = new URL(text(8192));
          if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
            throw new Error("invalid_input: 仅支持无凭据的网页链接");
          await this.options.openExternal(url.href);
          break;
        }
      }
      return { ok: true, value };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code =
        (["configuration", "busy", "not_found", "provider", "storage", "invalid_input"] as ErrorCode[]).find(
          (code) => message.startsWith(`${code}:`),
        ) ?? "invalid_input";
      return { ok: false, error: { code, message } };
    }
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.visible = false;
    this.unsubscribe();
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    await this.options.host.close();
  }
}
export function installQuickChatIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  quick: QuickChatWindow,
): () => void {
  ipc.handle("zpi:quick-chat", (event, method: unknown, args: unknown) => {
    if (!quick.owns(event))
      return { ok: false, error: { code: "invalid_input", message: "未授权的 IPC sender" } };
    return quick.call(method, args);
  });
  return () => ipc.removeHandler("zpi:quick-chat");
}
