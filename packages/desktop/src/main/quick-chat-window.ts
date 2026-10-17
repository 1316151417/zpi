import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  BrowserWindow,
  BrowserWindowConstructorOptions,
  Display,
  IpcMain,
  IpcMainInvokeEvent,
  Rectangle,
  SystemPreferences,
} from "electron";
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
  platform: NodeJS.Platform;
  getDisplay: (bounds?: Rectangle) => Pick<Display, "bounds" | "workArea">;
  loadSourceIcon: (url: string, signal: AbortSignal) => Promise<string | undefined>;
  workspaceNotifications?: Pick<
    SystemPreferences,
    "subscribeWorkspaceNotification" | "unsubscribeWorkspaceNotification"
  >;
  copyText: (text: string) => void;
  openExternal: (url: string) => Promise<void>;
}
/** Lazy floating window. Hiding never touches the run, and renderer reloads recover from the host. */
export class QuickChatWindow {
  private options: Options;
  private window?: BrowserWindow;
  private loading?: Promise<void>;
  private visible = false;
  private visibilityEpoch = 0;
  private opening = 0;
  private warmup?: ReturnType<typeof setTimeout>;
  private expanded = false;
  private disposed = false;
  private unsubscribe: () => void;
  private spaceSubscription?: number;
  constructor(options: Options) {
    this.options = options;
    if (options.platform === "darwin" && options.workspaceNotifications) {
      // A panel can remain key across Spaces. Blur alone is not proof that the
      // user has stayed on the invocation Space; hide on the native notification.
      this.spaceSubscription = options.workspaceNotifications.subscribeWorkspaceNotification(
        "NSWorkspaceActiveSpaceDidChangeNotification",
        () => this.hide(),
      );
    }
    this.unsubscribe = options.host.subscribe((snapshot) => {
      this.setExpanded(snapshot.session.runs.length > 0);
      const window = this.window;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed())
        window.webContents.send("zpi:quick-chat-snapshot", snapshot);
    });
  }
  private bounds(expanded: boolean, previous?: Rectangle): Rectangle {
    const display = this.options.getDisplay(previous);
    const area = display.workArea;
    const width = Math.min(expanded ? 660 : 360, area.width);
    const height = Math.min(expanded ? 560 : 44, area.height);
    // Public geometry only, in DIP. A visible bottom Dock/taskbar is an estimate
    // of its height; side/auto-hidden Docks have no useful bottom inset.
    const bottomInset = Math.max(0, display.bounds.y + display.bounds.height - area.y - area.height);
    const gap = bottomInset > 4 ? bottomInset : 64;
    return {
      width,
      height,
      x: Math.round(
        Math.max(
          area.x,
          Math.min(display.bounds.x + (display.bounds.width - width) / 2, area.x + area.width - width),
        ),
      ),
      y: Math.round(Math.max(area.y, area.y + area.height - gap - height)),
    };
  }
  private setExpanded(expanded: boolean): void {
    if (this.expanded === expanded) return;
    this.expanded = expanded;
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const bounds = this.bounds(expanded, window.getBounds());
    window.setMinimumSize(
      Math.min(expanded ? 440 : 360, bounds.width),
      Math.min(expanded ? 360 : 44, bounds.height),
    );
    window.setBounds(bounds);
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
    this.expanded = this.options.host.getSnapshot().session.runs.length > 0;
    const bounds = this.bounds(this.expanded);
    const window = this.options.createWindow({
      ...bounds,
      minWidth: Math.min(this.expanded ? 440 : 360, bounds.width),
      minHeight: Math.min(this.expanded ? 360 : 44, bounds.height),
      resizable: false,
      transparent: true,
      title: "快速对话",
      show: false,
      frame: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // Electron's nonactivating panel takes key focus without activating ZPI
      // or switching to the main window's Space. It already joins all Spaces;
      // toggling setVisibleOnAllWorkspaces would only add process-type changes.
      ...(this.options.platform === "darwin" ? { type: "panel", hiddenInMissionControl: true } : {}),
      backgroundColor: "#00000000",
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
      if (this.disposed || this.window !== window) return;
      event.preventDefault();
      this.hide();
    });
    window.on("hide", () => {
      if (this.window === window) this.visible = false;
    });
    window.on("blur", () => {
      if (this.window === window) this.hide();
    });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = undefined;
        this.visible = false;
      }
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
  /** Prepare only the renderer, without showing, refreshing, expiring, or creating a model session. */
  async prepare(): Promise<void> {
    await this.ready();
  }
  scheduleWarmup(onError: (error: unknown) => void): void {
    if (this.disposed || this.window || this.warmup) return;
    // Low-priority work after the main HTML load, never awaited by app startup.
    this.warmup = setTimeout(() => {
      this.warmup = undefined;
      void this.prepare().catch(onError);
    }, 1500);
    this.warmup.unref();
  }
  async show(): Promise<void> {
    if (this.disposed) return;
    this.visible = true;
    const epoch = ++this.visibilityEpoch;
    this.opening++;
    try {
      const [window] = await Promise.all([this.ready(), this.options.host.resetIfExpired()]);
      if (epoch !== this.visibilityEpoch || !this.visible || this.disposed || !window || window.isDestroyed())
        return;
      if (!this.options.hiddenTestMode) {
        if (window.isMinimized()) window.restore();
        // Geometry selects a display; the nonactivating panel is what keeps the
        // current macOS Space. Both fixed sizes share the same bottom anchor.
        const bounds = this.bounds(this.expanded);
        window.setMinimumSize(
          Math.min(this.expanded ? 440 : 360, bounds.width),
          Math.min(this.expanded ? 360 : 44, bounds.height),
        );
        window.setBounds(bounds);
        window.show();
        if (this.visible && !window.isDestroyed()) window.focus();
      }
      this.options.host.refreshSettings();
    } finally {
      this.opening--;
    }
  }
  async toggle(): Promise<void> {
    // Native visibility does not mean the window is foreground on this Space.
    // Preserve the desired visibility toggle while a renderer is still loading.
    if (
      this.visible &&
      (this.opening || this.loading || this.options.hiddenTestMode || this.window?.isFocused())
    )
      this.hide();
    else await this.show();
  }
  hide(): void {
    this.visibilityEpoch++;
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
        hide: 0,
        copyText: 1,
        openExternal: 1,
        readWebSourceIcon: 3,
      };
      if (!Object.hasOwn(counts, method) || args.length !== counts[method])
        throw new Error("invalid_input: 未知 IPC 方法或参数数量");
      const text = (limit: number, index = 0) => {
        if (typeof args[index] !== "string" || args[index].length > limit)
          throw new Error("invalid_input: 文本参数无效");
        return args[index] as string;
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
        case "hide":
          this.hide();
          break;
        case "copyText":
          this.options.copyText(text(1_000_000));
          break;
        case "readWebSourceIcon": {
          const dataUrl = await host.readWebSourceIcon(
            text(256),
            text(256, 1),
            text(8192, 2),
            this.options.loadSourceIcon,
          );
          value = dataUrl ? { dataUrl } : {};
          break;
        }
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
    clearTimeout(this.warmup);
    this.warmup = undefined;
    this.visible = false;
    this.unsubscribe();
    if (this.spaceSubscription !== undefined) {
      this.options.workspaceNotifications?.unsubscribeWorkspaceNotification(this.spaceSubscription);
      this.spaceSubscription = undefined;
    }
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
