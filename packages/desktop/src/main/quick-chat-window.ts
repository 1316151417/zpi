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
import type { QuickChatSnapshot } from "../shared/quick-chat.ts";
import { loadRenderer } from "./load-renderer.ts";
import { isPathInside } from "./path-bounds.ts";
import type { QuickChatHost } from "./quick-chat-host.ts";
import { resumeQuickChatExpanded } from "./quick-chat-presentation.ts";
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
  onError?: (error: unknown, method: string) => void;
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
  private keepExpanded = false;
  private hasRuns = false;
  private resettingPresentation?: { sessionId: string; expanded: boolean };
  private composerHeight = 44;
  private noticeHeight = 0;
  private sessionId: string;
  private snapshotRevision = 0;
  private presentationVersion = 0;
  private rendererVersion?: number;
  private composerProbe?: { token: number; sessionId: string; resolve: (occupied?: boolean) => void };
  private needsSessionFrame = false;
  private minimum?: [number, number];
  private readyWaiters = new Set<{ version: number; resolve: (ready: boolean) => void }>();
  private presentation?: { trace: QuickChatTrace; timer: ReturnType<typeof setTimeout> };
  private disposed = false;
  private unsubscribe: () => void;
  private spaceSubscription?: number;
  constructor(options: Options) {
    this.options = options;
    this.sessionId = options.host.sessionId;
    this.hasRuns = options.host.getSnapshot().session.runs.length > 0;
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
        this.keepExpanded = Boolean(
          this.resettingPresentation?.sessionId === this.sessionId && this.resettingPresentation.expanded,
        );
        this.sessionId = snapshot.session.sessionId;
        this.composerHeight = 44;
        this.noticeHeight = 0;
        this.cancelComposerProbe();
        this.invalidateFrame();
      }
      this.hasRuns = snapshot.session.runs.length > 0;
      this.setExpanded(this.keepExpanded || this.hasRuns);
      const window = this.window;
      if (window && !window.isDestroyed() && !window.webContents.isDestroyed()) {
        if (changedSession) this.applyBounds(window, this.bounds(this.expanded, window.getBounds()));
        window.webContents.send("zpi:quick-chat-snapshot", this.snapshot(snapshot));
      }
    });
  }
  private snapshot(snapshot = this.options.host.getSnapshot()): QuickChatSnapshot {
    return {
      ...snapshot,
      revision: ++this.snapshotRevision,
      presentationVersion: this.presentationVersion,
      expanded: this.expanded || snapshot.session.runs.length > 0,
    };
  }
  private resetConversation(trace?: QuickChatTrace): Promise<void> {
    trace?.mark("reset-start");
    const window = this.window;
    const presentation = {
      sessionId: this.options.host.sessionId,
      expanded: Boolean(this.expanded && window && !window.isDestroyed() && window.isVisible()),
    };
    this.visibilityEpoch++;
    this.cancelComposerProbe();
    this.cancelReadyWaiters();
    this.resettingPresentation = presentation;
    return this.options.host
      .reset()
      .then(() => {
        trace?.mark("reset-ready");
      })
      .finally(() => {
        if (this.resettingPresentation === presentation) this.resettingPresentation = undefined;
      });
  }
  /** Explicit new preserves expanded mode only when its native window is visible at invocation. */
  newConversation(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const trace = this.startTrace("new");
    return this.show(trace, this.resetConversation(trace));
  }
  private bounds(expanded: boolean, previous?: Rectangle): Rectangle {
    const display = this.options.getDisplay(previous);
    const area = display.workArea;
    const width = Math.min(expanded ? 660 : 360, area.width);
    const height = Math.min(expanded ? 560 : this.composerHeight + this.noticeHeight, area.height);
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
    if (expanded) this.noticeHeight = 0;
    this.invalidateFrame();
    const window = this.window;
    if (!window || window.isDestroyed()) return;
    const bounds = this.bounds(expanded, window.getBounds());
    this.applyBounds(window, bounds);
  }
  private minimumSize(bounds: Rectangle): [number, number] {
    return [
      Math.min(this.expanded ? 440 : 360, bounds.width),
      Math.min(this.expanded ? 360 : 44, bounds.height),
    ];
  }
  private applyBounds(window: BrowserWindow, bounds: Rectangle): void {
    const minimum = this.minimumSize(bounds);
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
  private setCompactHeight(
    field: "composerHeight" | "noticeHeight",
    sessionId: string,
    height: unknown,
    min: number,
    max: number,
    label: string,
  ): void {
    if (typeof height !== "number" || !Number.isFinite(height) || height < min || height > max)
      throw new Error(`invalid_input: ${label}`);
    if (sessionId !== this.options.host.sessionId || this.expanded) return;
    const next = Math.round(height);
    if (next === this[field]) return;
    this[field] = next;
    const window = this.window;
    if (window && !window.isDestroyed()) this.applyBounds(window, this.bounds(false, window.getBounds()));
  }
  private finishPresentation(outcome: "shown" | "hidden" | "failed" | "cancelled" | "timeout"): void {
    if (!this.presentation) return;
    clearTimeout(this.presentation.timer);
    this.presentation.trace.finish(outcome);
    this.presentation = undefined;
  }
  private invalidateFrame(): void {
    this.presentationVersion++;
    this.cancelReadyWaiters();
    this.rendererVersion = undefined;
    this.needsSessionFrame = true;
  }
  private cancelComposerProbe(): void {
    this.composerProbe?.resolve();
  }
  private probeComposer(window: BrowserWindow, epoch: number): Promise<boolean | undefined> {
    this.cancelComposerProbe();
    return new Promise((resolve) => {
      const probe = {
        token: epoch,
        sessionId: this.sessionId,
        resolve: (occupied?: boolean) => {
          clearTimeout(timer);
          if (this.composerProbe === probe) this.composerProbe = undefined;
          resolve(occupied);
        },
      };
      // A missing renderer response must not lose a draft or strand the shortcut.
      // Unknown preserves the large window and the next resume can ask again.
      const timer = setTimeout(() => probe.resolve(), 250);
      timer.unref();
      this.composerProbe = probe;
      window.webContents.send("zpi:quick-chat-composer", probe.token, probe.sessionId);
    });
  }
  private cancelReadyWaiters(): void {
    for (const waiter of [...this.readyWaiters]) waiter.resolve(false);
  }
  private waitForSession(version: number, epoch: number): Promise<boolean> {
    if (epoch !== this.visibilityEpoch || !this.visible || this.disposed) return Promise.resolve(false);
    if (this.rendererVersion === version) return Promise.resolve(true);
    const window = this.window;
    return new Promise((resolveReady, reject) => {
      const waiter = {
        version,
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
    this.expanded = this.keepExpanded || this.hasRuns;
    this.noticeHeight = 0;
    const bounds = this.bounds(this.expanded);
    const minimum = this.minimumSize(bounds);
    const window = this.options.createWindow({
      ...bounds,
      minWidth: minimum[0],
      minHeight: minimum[1],
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
    this.minimum = minimum;
    this.rendererVersion = undefined;
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
      this.cancelComposerProbe();
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
    window.webContents.on("did-start-navigation", (details) => {
      // Draft images belong to this renderer. Reload/crash may skip React cleanup;
      // keep accepted history images, but release invisible draft imports and entries.
      if (
        this.window === window &&
        details.isMainFrame &&
        !details.isSameDocument &&
        details.url.split("#")[0] === window.webContents.getURL().split("#")[0]
      ) {
        this.options.host.discardDraftAttachments();
        if (this.noticeHeight) {
          this.noticeHeight = 0;
          this.applyBounds(window, this.bounds(this.expanded, window.getBounds()));
        }
        this.invalidateFrame();
      }
    });
    window.on("closed", () => {
      if (this.window === window) {
        this.options.host.discardDraftAttachments();
        this.window = undefined;
        this.visible = false;
        this.rendererVersion = undefined;
        this.cancelComposerProbe();
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
  private startTrace(kind: "open" | "new" = "open"): QuickChatTrace | undefined {
    return this.options.timing?.start(
      kind,
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
  show(trace = this.startTrace(), reset?: Promise<void>): Promise<void> {
    if (this.disposed) {
      trace?.finish("cancelled");
      return Promise.resolve();
    }
    const wasHidden = !this.visible || !this.window || this.window.isDestroyed() || !this.window.isVisible();
    this.visible = true;
    const epoch = ++this.visibilityEpoch;
    this.cancelComposerProbe();
    this.cancelReadyWaiters();
    const resetting = reset ?? (wasHidden ? this.options.host.resetIfExpired() : undefined);
    if (!resetting) trace?.mark("expiry-ready");
    const warm = this.window && !this.window.isDestroyed() && !this.loading;
    const checkComposer = !resetting && wasHidden && this.expanded && !this.hasRuns;
    if (warm && !resetting && !checkComposer && !this.needsSessionFrame) {
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
        if (checkComposer) {
          const sessionId = this.sessionId;
          const occupied = await this.probeComposer(window, epoch);
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
          if (sessionId === this.sessionId) {
            const expanded = resumeQuickChatExpanded(this.expanded, this.hasRuns, occupied);
            if (expanded !== this.expanded) {
              this.keepExpanded = false;
              this.setExpanded(expanded);
              window.webContents.send("zpi:quick-chat-snapshot", this.snapshot());
            }
          }
        }
        // Expiry or a mode change sent a snapshot, but the old renderer frame may still exist.
        // Ordinary retained-history opens skip this post-commit frame acknowledgement.
        while (resetting || this.needsSessionFrame) {
          const version = this.presentationVersion;
          trace?.mark("session-frame-wait");
          if (await this.waitForSession(version, epoch)) {
            trace?.mark("session-frame-ready");
            break;
          }
          if (version !== this.presentationVersion && epoch === this.visibilityEpoch && this.visible)
            continue;
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
  /** Both global shortcuts cancel an open/pending presentation; only their opening action differs. */
  toggle(newConversation = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const trace = this.startTrace(newConversation ? "new" : "open");
    const window = this.window;
    const nativeFocused = window && !window.isDestroyed() && window.isVisible() && window.isFocused();
    if (nativeFocused || (this.visible && (this.opening || this.loading || this.options.hiddenTestMode))) {
      this.hide("toggle-hide");
      trace?.finish("hidden");
      return Promise.resolve();
    }
    return this.show(trace, newConversation ? this.resetConversation(trace) : undefined);
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
    this.cancelComposerProbe();
    this.cancelReadyWaiters();
    this.finishPresentation("hidden");
    if (this.window && !this.window.isDestroyed()) this.window.hide();
  }
  async call(method: unknown, args: unknown): Promise<Result<unknown>> {
    try {
      if (this.disposed) throw new Error("busy: 快速对话正在关闭");
      if (typeof method !== "string" || !Array.isArray(args)) throw new Error("invalid_input: 未知 IPC 方法");
      const counts: Record<string, number | number[]> = {
        getSnapshot: 0,
        send: [1, 2],
        importAttachment: 3,
        readAttachment: 2,
        removeAttachment: 2,
        stop: 0,
        reset: 0,
        hide: 0,
        copyText: 1,
        openExternal: 1,
        readWebSourceIcon: 3,
        setComposerHeight: 2,
        setNoticeHeight: 2,
        rendererReady: 2,
        reportComposerState: 3,
        reportPresentation: 2,
      };
      const count = counts[method];
      if (
        !Object.hasOwn(counts, method) ||
        !(Array.isArray(count) ? count.includes(args.length) : args.length === count)
      )
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
          const version = args[1];
          if (!Number.isSafeInteger(version) || (version as number) < 0)
            throw new Error("invalid_input: 展示版本无效");
          if (sessionId !== host.sessionId || version !== this.presentationVersion) break;
          this.rendererVersion = version as number;
          this.needsSessionFrame = false;
          for (const waiter of [...this.readyWaiters]) if (waiter.version === version) waiter.resolve(true);
          break;
        }
        case "reportComposerState": {
          const token = args[0];
          const sessionId = text(256, 1);
          const occupied = args[2];
          if (!Number.isSafeInteger(token) || typeof occupied !== "boolean")
            throw new Error("invalid_input: 输入状态无效");
          const probe = this.composerProbe;
          if (probe && probe.token === token && probe.sessionId === sessionId && sessionId === host.sessionId)
            probe.resolve(occupied);
          break;
        }
        case "setComposerHeight":
          this.setCompactHeight("composerHeight", text(256), args[1], 44, 240, "输入框高度无效");
          break;
        case "setNoticeHeight":
          this.setCompactHeight("noticeHeight", text(256), args[1], 0, 172, "提示区域高度无效");
          break;
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
          value = this.snapshot();
          break;
        case "send": {
          const attachments = args[1];
          if (
            attachments !== undefined &&
            (!Array.isArray(attachments) ||
              attachments.some((id) => typeof id !== "string" || id.length > 256))
          )
            throw new Error("invalid_input: 图片列表参数无效");
          host.send(text(32_000), attachments as string[] | undefined);
          break;
        }
        case "importAttachment": {
          const bytes = args[2];
          if (!(bytes instanceof Uint8Array)) throw new Error("invalid_input: 图片数据无效");
          value = await host.importAttachment(text(256), text(250, 1), bytes);
          break;
        }
        case "readAttachment":
          value = await host.readAttachment(text(256), text(256, 1));
          break;
        case "removeAttachment":
          await host.removeAttachment(text(256), text(256, 1));
          break;
        case "stop":
          await host.stop();
          break;
        case "reset":
          await this.resetConversation();
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
      try {
        this.options.onError?.(error, typeof method === "string" ? method : "unknown");
      } catch {
        // Logging must not prevent the operation failure from reaching the renderer.
      }
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
    this.cancelComposerProbe();
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
