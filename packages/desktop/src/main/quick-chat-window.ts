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
import type { QuickChatStage, QuickChatTiming, QuickChatTrace } from "./quick-chat-timing.ts";

interface Options {
  host: QuickChatHost;
  timing?: QuickChatTiming;
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
  private presenting = false;
  private warmup?: ReturnType<typeof setTimeout>;
  private expanded = false;
  private composerHeight = 44;
  private sessionId: string;
  private rendererSessionId?: string;
  private needsSessionFrame = false;
  private minimum?: [number, number];
  private readyWaiters = new Set<{ sessionId: string; resolve: (ready: boolean) => void }>();
  private presentation?: { trace: QuickChatTrace; timer: ReturnType<typeof setTimeout> };
  private disposed = false;
  private unsubscribe: () => void;
  private spaceSubscription?: number;
  constructor(options: Options) {
    this.options = options;
    this.sessionId = options.host.sessionId;
    if (options.platform === "darwin" && options.workspaceNotifications) {
      // A panel can remain key across Spaces. Blur alone is not proof that the
      // user has stayed on the invocation Space; hide on the native notification.
      this.spaceSubscription = options.workspaceNotifications.subscribeWorkspaceNotification(
        "NSWorkspaceActiveSpaceDidChangeNotification",
        () => this.hide("space-changed"),
      );
    }
    this.unsubscribe = options.host.subscribe((snapshot) => {
      const changedSession = snapshot.session.sessionId !== this.sessionId;
      if (changedSession) {
        this.sessionId = snapshot.session.sessionId;
        this.composerHeight = 44;
        this.rendererSessionId = undefined;
        this.needsSessionFrame = true;
      }
      this.setExpanded(snapshot.session.runs.length > 0);
      const window = this.window;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        if (changedSession) this.applyBounds(window, this.bounds(this.expanded, window.getBounds()));
        window.webContents.send("zpi:quick-chat-snapshot", snapshot);
      }
    });
  }
  private bounds(expanded: boolean, previous?: Rectangle): Rectangle {
    const display = this.options.getDisplay(previous);
    const area = display.workArea;
    const width = Math.min(expanded ? 660 : 360, area.width);
    const height = Math.min(expanded ? 560 : this.composerHeight, area.height);
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
    this.applyBounds(window, bounds);
  }
  private applyBounds(window: BrowserWindow, bounds: Rectangle): void {
    const minimum: [number, number] = [
      Math.min(this.expanded ? 440 : 360, bounds.width),
      Math.min(this.expanded ? 360 : 44, bounds.height),
    ];
    if (!this.minimum || minimum.some((size, index) => size !== this.minimum?.[index])) {
      window.setMinimumSize(...minimum);
      this.minimum = minimum;
    }
    const current = window.getBounds();
    if (
      current.x !== bounds.x ||
      current.y !== bounds.y ||
      current.width !== bounds.width ||
      current.height !== bounds.height
    )
      window.setBounds(bounds);
  }
  private finishPresentation(outcome: "shown" | "hidden" | "failed" | "cancelled" | "timeout"): void {
    if (!this.presentation) return;
    clearTimeout(this.presentation.timer);
    this.presentation.trace.finish(outcome);
    this.presentation = undefined;
  }
  private cancelReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) waiter.resolve(false);
  }
  private waitForSession(sessionId: string, epoch: number): Promise<boolean> {
    if (epoch !== this.visibilityEpoch || !this.visible || this.disposed) return Promise.resolve(false);
    if (this.rendererSessionId === sessionId) return Promise.resolve(true);
    const window = this.window;
    return new Promise((resolveReady, reject) => {
      const waiter = {
        sessionId,
        resolve: (ready: boolean) => {
          clearTimeout(timer);
          this.readyWaiters.delete(waiter);
          resolveReady(ready);
        },
      };
      const timer = setTimeout(() => {
        this.readyWaiters.delete(waiter);
        // A lost acknowledgement must not strand every subsequent shortcut. The
        // host survives; retry creates a fresh renderer with no stale pixels.
        if (window === this.window && !window?.isDestroyed()) window?.destroy();
        reject(new Error("快速对话页面未准备就绪，请重试"));
      }, 5000);
      timer.unref();
      this.readyWaiters.add(waiter);
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
  private async ready(trace?: QuickChatTrace): Promise<BrowserWindow | undefined> {
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
    trace?.mark("window-created");
    this.minimum = [
      Math.min(this.expanded ? 440 : 360, bounds.width),
      Math.min(this.expanded ? 360 : 44, bounds.height),
    ];
    this.rendererSessionId = undefined;
    this.needsSessionFrame = false;
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
    window.on("show", () => {
      if (this.window === window) this.presentation?.trace.mark("native-show");
    });
    window.on("focus", () => {
      if (this.window === window) this.presentation?.trace.mark("native-focus");
    });
    window.on("close", (event) => {
      if (this.disposed || this.window !== window) return;
      event.preventDefault();
      this.hide("native-close");
    });
    window.on("hide", () => {
      if (this.window !== window) return;
      if (window.isVisible()) {
        this.recordState("hide-ignored");
        return;
      }
      this.visible = false;
      this.cancelReadyWaiters();
      this.recordState("native-hidden");
      this.finishPresentation("hidden");
    });
    window.on("blur", () => {
      if (this.window !== window) return;
      const epoch = this.visibilityEpoch;
      const reconcile = () => {
        if (this.window !== window || window.isDestroyed() || epoch !== this.visibilityEpoch || !this.visible)
          return;
        if (window.isFocused()) {
          this.recordState("blur-ignored");
          return;
        }
        this.hide("blur-unfocused");
      };
      // A queued blur from the previous presentation must not undo newly acquired
      // focus. During show(), recheck after its synchronous focus work completes.
      if (this.presenting) queueMicrotask(reconcile);
      else reconcile();
    });
    window.on("closed", () => {
      if (this.window === window) {
        this.window = undefined;
        this.visible = false;
        this.rendererSessionId = undefined;
        this.cancelReadyWaiters();
        this.finishPresentation("cancelled");
      }
    });
    window.webContents.on("render-process-gone", () => {
      if (!window.isDestroyed()) window.destroy();
    });
    const url = new URL(this.options.rendererUrl);
    url.searchParams.set("view", "quick-chat");
    this.loading = loadRenderer(window, url.href)
      .then(() => {
        trace?.mark("window-loaded");
      })
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
  /** Prepare only the renderer; no show, expiry, settings refresh, or model session. */
  async prepare(): Promise<void> {
    const trace = this.options.timing?.start(
      "warmup",
      this.loading ? "loading" : this.window ? "warm" : "cold",
    );
    try {
      await this.ready(trace);
      trace?.mark("window-ready");
      trace?.finish(this.disposed ? "cancelled" : "ready");
    } catch (error) {
      trace?.finish("failed");
      throw error;
    }
  }
  scheduleWarmup(onError: (error: unknown) => void): void {
    if (this.disposed || this.window || this.warmup) return;
    this.warmup = setTimeout(() => {
      this.warmup = undefined;
      void this.prepare().catch(onError);
    }, 1500);
    this.warmup.unref();
  }
  private startTrace(): QuickChatTrace | undefined {
    return this.options.timing?.start(
      "open",
      this.loading ? "loading" : this.window && !this.window.isDestroyed() ? "warm" : "cold",
    );
  }
  private present(window: BrowserWindow, epoch: number, trace?: QuickChatTrace): void {
    if (
      epoch !== this.visibilityEpoch ||
      !this.visible ||
      this.disposed ||
      window !== this.window ||
      window.isDestroyed()
    ) {
      trace?.finish("cancelled");
      return;
    }
    if (trace) {
      this.finishPresentation("cancelled");
      const timer = setTimeout(() => this.finishPresentation("timeout"), 3000);
      timer.unref();
      this.presentation = { trace, timer };
      window.webContents.send("zpi:quick-chat-presentation", trace.id);
    }
    if (!this.options.hiddenTestMode) {
      this.presenting = true;
      try {
        if (window.isMinimized()) window.restore();
        this.applyBounds(window, this.bounds(this.expanded));
        trace?.mark("geometry");
        window.show();
        trace?.mark("show");
        if (this.visible && !window.isDestroyed() && !window.isFocused()) window.focus();
        trace?.mark("focus");
      } finally {
        this.presenting = false;
      }
    }
    // Settings mutations already publish their updates. Reopening must not clone
    // and resend the entire conversation or schedule a rich renderer rerender.
  }
  show(trace = this.startTrace()): Promise<void> {
    if (this.disposed) {
      trace?.finish("cancelled");
      return Promise.resolve();
    }
    this.visible = true;
    const epoch = ++this.visibilityEpoch;
    const resetting = this.options.host.resetIfExpired();
    if (!resetting) trace?.mark("expiry-ready");
    const warm = this.window && !this.window.isDestroyed() && !this.loading;
    if (warm && !resetting && !this.needsSessionFrame) {
      // The retained-window hot path stays in the global-shortcut callback stack.
      trace?.mark("window-ready");
      this.present(this.window as BrowserWindow, epoch, trace);
      return Promise.resolve();
    }
    this.opening++;
    return Promise.all([this.ready(trace), resetting?.then(() => trace?.mark("expiry-ready"))])
      .then(async ([window]) => {
        trace?.mark("window-ready");
        if (
          !window ||
          window.isDestroyed() ||
          this.disposed ||
          epoch !== this.visibilityEpoch ||
          !this.visible
        ) {
          trace?.finish("cancelled");
          return;
        }
        // Expiry sent a new snapshot, but the old renderer frame may still exist.
        // Only this path waits for the new session's post-commit frame acknowledgement.
        if (
          (resetting || this.needsSessionFrame) &&
          !(await this.waitForSession(this.options.host.sessionId, epoch))
        ) {
          trace?.finish("cancelled");
          return;
        }
        this.present(window, epoch, trace);
      })
      .catch((error: unknown) => {
        trace?.finish("failed");
        throw error;
      })
      .finally(() => {
        this.opening--;
      });
  }
  toggle(): Promise<void> {
    const trace = this.startTrace();
    const window = this.window;
    const nativeFocused = window && !window.isDestroyed() && window.isVisible() && window.isFocused();
    if (nativeFocused || (this.visible && (this.opening || this.loading || this.options.hiddenTestMode))) {
      this.hide("toggle-hide");
      trace?.finish("hidden");
      return Promise.resolve();
    }
    return this.show(trace);
  }
  private recordState(stage: QuickChatStage): void {
    const window = this.window;
    const state = {
      visible: Boolean(window && !window.isDestroyed() && window.isVisible()),
      focused: Boolean(window && !window.isDestroyed() && window.isFocused()),
      expanded: this.expanded,
    };
    if (this.presentation) this.presentation.trace.mark(stage, state);
    else {
      const trace = this.options.timing?.start(
        "hide",
        this.loading ? "loading" : this.window ? "warm" : "cold",
      );
      trace?.mark(stage, state);
      trace?.finish(stage === "blur-ignored" || stage === "hide-ignored" ? "shown" : "hidden");
    }
  }
  hide(reason: QuickChatStage = "program-hide"): void {
    this.recordState(reason);
    this.visibilityEpoch++;
    this.visible = false;
    this.cancelReadyWaiters();
    this.finishPresentation("hidden");
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
        setComposerHeight: 2,
        rendererReady: 1,
        reportPresentation: 2,
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
        case "rendererReady": {
          const sessionId = text(256);
          if (sessionId !== host.sessionId) break;
          this.rendererSessionId = sessionId;
          this.needsSessionFrame = false;
          for (const waiter of [...this.readyWaiters])
            if (waiter.sessionId === sessionId) waiter.resolve(true);
          break;
        }
        case "setComposerHeight": {
          const sessionId = text(256);
          const height = args[1];
          if (typeof height !== "number" || !Number.isFinite(height) || height < 44 || height > 184)
            throw new Error("invalid_input: 输入框高度无效");
          if (sessionId !== host.sessionId || this.expanded) break;
          const next = Math.round(height);
          if (next === this.composerHeight) break;
          this.composerHeight = next;
          const window = this.window;
          if (window && !window.isDestroyed())
            this.applyBounds(window, this.bounds(false, window.getBounds()));
          break;
        }
        case "reportPresentation": {
          const token = args[0];
          const stage = args[1];
          if (
            !Number.isSafeInteger(token) ||
            !["renderer-ready", "renderer-focus", "renderer-frame"].includes(stage as string)
          )
            throw new Error("invalid_input: 显示计时参数无效");
          if (token !== this.presentation?.trace.id) break;
          this.presentation?.trace.mark(stage as "renderer-ready" | "renderer-focus" | "renderer-frame");
          if (stage === "renderer-frame") this.finishPresentation("shown");
          break;
        }
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
          this.hide("ipc-hide");
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
    this.cancelReadyWaiters();
    this.finishPresentation("cancelled");
    this.unsubscribe();
    if (this.spaceSubscription !== undefined) {
      this.options.workspaceNotifications?.unsubscribeWorkspaceNotification(this.spaceSubscription);
      this.spaceSubscription = undefined;
    }
    if (this.window && !this.window.isDestroyed()) this.window.destroy();
    await this.options.host.close();
    await this.options.timing?.flush();
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
