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
import type { QuickChatDraftInput, QuickChatSnapshot } from "../shared/quick-chat.ts";
import { loadRenderer } from "./load-renderer.ts";
import { isPathInside } from "./path-bounds.ts";
import type { QuickChatHost } from "./quick-chat-host.ts";
import { resumeQuickChatExpanded } from "./quick-chat-presentation.ts";
import type {
  QuickChatStage,
  QuickChatTiming,
  QuickChatTimingState,
  QuickChatTrace,
} from "./quick-chat-timing.ts";

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
  activateApp?: () => (() => void) | undefined;
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
  private opening?: {
    epoch: number;
    creating: boolean;
    phase: "preparing" | "presenting";
    promise: Promise<void>;
  };
  private presenting = false;
  private returnFocus?: () => void;
  private warmup?: ReturnType<typeof setTimeout>;
  private expanded = false;
  private keepExpanded = false;
  private hasRuns = false;
  private resettingPresentation?: {
    sessionId: string;
    expanded: boolean;
    promise?: Promise<void>;
    ready: boolean;
  };
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
  private draftInput?: { epoch: number; sessionId: string; input: QuickChatDraftInput };
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
      this.recordEvent("snapshot-received");
      const changedSession = snapshot.session.sessionId !== this.sessionId;
      if (changedSession) {
        this.draftInput = undefined;
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
        this.recordEvent("snapshot-bounds");
        window.webContents.send("zpi:quick-chat-snapshot", this.snapshot(snapshot));
        this.recordEvent("snapshot-sent");
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
    const presentation: NonNullable<QuickChatWindow["resettingPresentation"]> = {
      sessionId: this.options.host.sessionId,
      ready: false,
      expanded: Boolean(this.expanded && window && !window.isDestroyed() && window.isVisible()),
    };
    this.visibilityEpoch++;
    this.cancelComposerProbe();
    this.cancelReadyWaiters();
    this.resettingPresentation = presentation;
    const resetting = this.options.host.reset(trace);
    trace?.mark("reset-dispatched");
    presentation.promise = resetting.then(
      () => {
        trace?.mark("reset-ready");
        presentation.ready = true;
        // The + button does not open the window, but its new session is still
        // pending until the renderer has committed the replacement frame.
        if (this.resettingPresentation === presentation && this.rendererVersion === this.presentationVersion)
          this.resettingPresentation = undefined;
      },
      (error: unknown) => {
        if (this.resettingPresentation === presentation) this.resettingPresentation = undefined;
        throw error;
      },
    );
    return presentation.promise;
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
  private applyBounds(window: BrowserWindow, bounds: Rectangle, valid?: () => boolean): void {
    const minimum = this.minimumSize(bounds);
    if (!this.minimum || minimum.some((size, index) => size !== this.minimum?.[index])) {
      this.minimum = minimum;
      window.setMinimumSize(...minimum);
    }
    if (window.isDestroyed() || (valid && !valid())) return;
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
    this.cancelComposerProbe();
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
      // Missing responses are unknown, never evidence of an empty composer.
      // Resume preserves drafts; an explicit new intent can still reset them.
      const timer = setTimeout(() => {
        this.recordEvent("composer-timeout");
        probe.resolve();
      }, 250);
      timer.unref();
      this.composerProbe = probe;
      this.recordEvent("composer-probe");
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
      // The panel joins all Spaces without moving the main window. Activation
      // after showing it is still needed for reliable native keyboard routing.
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
        additionalArguments: this.options.timing ? ["--zpi-quick-chat-timing"] : [],
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
      if (this.window === window) {
        this.presentation?.trace.mark("native-show");
        this.recordEvent("native-show");
      }
    });
    window.on("focus", () => {
      if (this.window === window) {
        this.presentation?.trace.mark("native-focus");
        this.recordEvent("native-focus");
      }
    });
    window.webContents.on("before-input-event", (_event, input) => {
      if (this.window === window && input.type === "keyDown") this.recordEvent("native-keydown");
    });
    window.on("close", (event) => {
      if (this.disposed || this.window !== window) return;
      event.preventDefault();
      this.hide("native-close");
    });
    window.on("hide", () => {
      if (this.window !== window) return;
      if (window.isVisible() || this.preparingHiddenWindow()) {
        this.recordState("hide-ignored");
        return;
      }
      this.visible = false;
      this.returnFocus = undefined;
      this.draftInput = undefined;
      this.cancelComposerProbe();
      this.cancelReadyWaiters();
      this.recordState("native-hidden");
      this.finishPresentation("hidden");
    });
    window.on("blur", () => {
      if (this.window !== window) return;
      this.recordEvent("native-blur");
      const epoch = this.visibilityEpoch;
      const reconcile = () => {
        if (this.window !== window || window.isDestroyed() || epoch !== this.visibilityEpoch || !this.visible)
          return;
        if (window.isFocused()) {
          this.recordState("blur-ignored");
          return;
        }
        // Cocoa can deliver hide()'s blur after the next invocation has started.
        // A still-hidden renderer preparing a replacement has no current native
        // surface to dismiss. Only a presented window can lose user focus.
        if (!window.isVisible() && this.preparingHiddenWindow()) {
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
        this.returnFocus = undefined;
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
    const trace = this.options.timing?.start(
      kind,
      this.loading ? "loading" : this.window && !this.window.isDestroyed() ? "warm" : "cold",
    );
    if (!trace) return;
    trace.mark("open-request", this.timingState());
    return {
      id: trace.id,
      mark: (stage, state) => trace.mark(stage, { ...this.timingState(), ...state }),
      finish: (outcome) => trace.finish(outcome),
    };
  }
  private timingState(): QuickChatTimingState {
    const window = this.window;
    const live = window && !window.isDestroyed();
    return {
      visible: Boolean(live && window.isVisible()),
      focused: Boolean(live && window.isFocused()),
      expanded: this.expanded,
      intent: this.visible,
      epoch: this.visibilityEpoch,
      opening: this.opening?.epoch,
      openingPhase: this.opening?.phase,
      resetting: Boolean(this.resettingPresentation),
      sessionId: this.sessionId,
      version: this.presentationVersion,
      rendererVersion: this.rendererVersion,
      waiters: this.readyWaiters.size,
      probe: this.composerProbe?.token,
      windowId: live ? window.id : undefined,
    };
  }
  recordShortcut = (
    stage: QuickChatStage,
    binding: string,
    registrationVersion: number,
    registered: boolean,
  ): void => {
    this.recordEvent(stage, { binding, registrationVersion, registered });
  };
  private recordEvent(stage: QuickChatStage, details?: Partial<QuickChatTimingState>): void {
    if (!this.options.timing) return;
    const trace = this.options.timing.start(
      "event",
      this.loading ? "loading" : this.window ? "warm" : "cold",
    );
    trace?.mark(stage, { ...this.timingState(), ...details });
    trace?.finish("ready");
  }
  private present(
    window: BrowserWindow,
    epoch: number,
    trace?: QuickChatTrace,
    input?: QuickChatDraftInput,
  ): void {
    const current = () =>
      epoch === this.visibilityEpoch &&
      this.visible &&
      !this.disposed &&
      window === this.window &&
      !window.isDestroyed();
    const cancelled = () => {
      if (current()) return false;
      trace?.finish("cancelled");
      // A native call may complete its show after reentering hide. Only retire
      // this cancelled intent, never a newer invocation of the same window.
      if (window === this.window && !window.isDestroyed() && !this.visible && window.isVisible())
        window.hide();
      return true;
    };
    if (cancelled()) return;
    if (input) {
      this.draftInput = { epoch, sessionId: this.sessionId, input };
      this.recordEvent("draft-offered");
      window.webContents.send("zpi:quick-chat-draft");
      if (cancelled()) return;
    }
    if (trace) {
      this.finishPresentation("cancelled");
      const timer = setTimeout(() => this.finishPresentation("timeout"), 3000);
      timer.unref();
      this.presentation = { trace, timer };
      window.webContents.send("zpi:quick-chat-presentation", trace.id);
      if (cancelled()) return;
    }
    if (!this.options.hiddenTestMode) {
      this.presenting = true;
      try {
        if (window.isMinimized()) window.restore();
        if (cancelled()) return;
        // A hidden or unfocused invocation follows the pointer display. Content
        // brought into the focused panel must not undo its dragged position.
        if (!window.isVisible() || !window.isFocused())
          this.applyBounds(window, this.bounds(this.expanded), current);
        if (cancelled()) return;
        trace?.mark("geometry");
        if (this.opening?.epoch === epoch) this.opening.phase = "presenting";
        window.show();
        trace?.mark("show");
        if (cancelled()) return;
        if (this.options.platform === "darwin") {
          let restore: (() => void) | undefined;
          try {
            restore = this.options.activateApp?.();
          } catch (error) {
            this.options.onError?.(error, "activateApp");
          }
          if (cancelled()) return;
          if (restore && !this.returnFocus) this.returnFocus = restore;
        }
        if (this.options.platform === "darwin" || !window.isFocused()) window.focus();
        if (cancelled()) return;
        trace?.mark("focus");
      } finally {
        this.presenting = false;
      }
    }
    // Settings mutations already publish their updates. Reopening must not clone
    // and resend the entire conversation or schedule a rich renderer rerender.
  }
  openWithDraft(input: QuickChatDraftInput, expectedSessionId: string): Promise<void> {
    if (expectedSessionId !== this.sessionId) return Promise.resolve();
    return this.show(this.startTrace(), undefined, input);
  }
  show(trace = this.startTrace(), reset?: Promise<void>, input?: QuickChatDraftInput): Promise<void> {
    if (this.disposed) {
      trace?.finish("cancelled");
      return Promise.resolve();
    }
    const wasHidden = !this.visible || !this.window || this.window.isDestroyed() || !this.window.isVisible();
    this.visible = true;
    const epoch = ++this.visibilityEpoch;
    this.draftInput = undefined;
    this.cancelComposerProbe();
    this.cancelReadyWaiters();
    const resetting = reset ?? (wasHidden ? this.options.host.resetIfExpired() : undefined);
    if (!resetting) trace?.mark("expiry-ready");
    const warm = this.window && !this.window.isDestroyed() && !this.loading;
    // An ordinary resume may be waiting for an explicit reset. Decide against
    // its resulting session, not the old history before that reset finishes.
    const checkComposer = () => !reset && wasHidden && this.expanded && !this.hasRuns;
    if (warm && !resetting && !checkComposer() && !this.needsSessionFrame) {
      // The retained-window hot path stays in the global-shortcut callback stack.
      trace?.mark("window-ready");
      this.present(this.window as BrowserWindow, epoch, trace, input);
      return Promise.resolve();
    }
    const prepare = async (window: BrowserWindow | undefined) => {
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
      if (checkComposer()) {
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
        if (version !== this.presentationVersion && epoch === this.visibilityEpoch && this.visible) continue;
        trace?.finish("cancelled");
        return;
      }
      this.present(window, epoch, trace, input);
    };
    // A warm window can start its first IPC in the native shortcut stack. An
    // already-resolved ready() promise can otherwise leave this work waiting
    // for the next event-loop wakeup before even asking about the draft.
    const preparing =
      warm && !resetting
        ? prepare(this.window)
        : Promise.all([this.ready(trace), resetting?.then(() => trace?.mark("expiry-ready"))]).then(
            ([window]) => prepare(window),
          );
    const promise = preparing
      .catch((error: unknown) => {
        trace?.finish("failed");
        throw error;
      })
      .finally(() => {
        if (this.opening?.epoch === epoch) this.opening = undefined;
      });
    this.opening = {
      epoch,
      creating: Boolean(resetting),
      phase:
        this.window && !this.window.isDestroyed() && this.window.isVisible() ? "presenting" : "preparing",
      promise,
    };
    return promise;
  }
  /** A new shortcut may hide only a confirmed empty, already presented session. */
  private toggleEmptyConversation(window: BrowserWindow, trace?: QuickChatTrace): Promise<void> {
    this.visible = true;
    const epoch = ++this.visibilityEpoch;
    const sessionId = this.sessionId;
    const version = this.presentationVersion;
    const promise = this.probeComposer(window, epoch)
      .then((occupied) => {
        if (
          epoch !== this.visibilityEpoch ||
          sessionId !== this.sessionId ||
          !this.visible ||
          this.disposed ||
          window !== this.window ||
          window.isDestroyed()
        ) {
          trace?.finish("cancelled");
          return;
        }
        // Runs may arrive while asking the renderer. A changed frame or missing
        // reply is unknown, never proof that the draft is empty. Explicit new
        // still means reset in that case; ordinary toggle never uses this path.
        if (!this.hasRuns && version === this.presentationVersion && occupied === false) {
          this.hide("toggle-hide");
          trace?.finish("hidden");
          return;
        }
        return this.show(trace, this.resetConversation(trace));
      })
      .catch((error: unknown) => {
        trace?.finish("failed");
        throw error;
      })
      .finally(() => {
        if (this.opening?.epoch === epoch) this.opening = undefined;
      });
    this.opening = { epoch, creating: true, phase: "presenting", promise };
    return promise;
  }
  /** Pending new intents coalesce; ordinary toggle remains a visibility action. */
  async toggle(newConversation = false): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const window = this.window;
    const nativeFocused = window && !window.isDestroyed() && window.isVisible() && window.isFocused();
    const opening = this.visible && this.opening?.epoch === this.visibilityEpoch ? this.opening : undefined;
    // Old pixels can still be visible/focused during reset or its frame wait.
    // Repeated new must not cancel that operation or start another reset chain.
    if (newConversation && opening?.creating) {
      this.recordEvent("new-coalesced");
      return opening.promise.catch(() => {});
    }
    const trace = this.startTrace(newConversation ? "new" : "open");
    if (newConversation) {
      const resetting = this.visible ? this.resettingPresentation?.promise : undefined;
      if (resetting) {
        // The + operation owns reset errors; this shortcut owns only a later
        // presentation failure. Neither should report the same failed reset twice.
        let resetFailed = false;
        return this.show(
          trace,
          resetting.catch((error: unknown) => {
            resetFailed = true;
            throw error;
          }),
        ).catch((error: unknown) => {
          if (!resetFailed) throw error;
        });
      }
      if (
        !this.hasRuns &&
        window &&
        (nativeFocused || (this.visible && this.options.hiddenTestMode && !opening))
      )
        return this.toggleEmptyConversation(window, trace);
      return this.show(trace, this.resetConversation(trace));
    }
    if (nativeFocused || (this.visible && (opening || this.loading || this.options.hiddenTestMode))) {
      this.hide("toggle-hide");
      trace?.finish("hidden");
      return Promise.resolve();
    }
    return this.show(trace);
  }
  private recordState(stage: QuickChatStage): void {
    const state = this.timingState();
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
  private preparingHiddenWindow(): boolean {
    return this.visible && this.opening?.epoch === this.visibilityEpoch && this.opening.phase === "preparing";
  }
  hide(reason: QuickChatStage = "program-hide"): void {
    this.draftInput = undefined;
    this.recordState(reason);
    this.visibilityEpoch++;
    this.visible = false;
    this.cancelComposerProbe();
    this.cancelReadyWaiters();
    this.finishPresentation("hidden");
    const window = this.window;
    const returnFocus = this.returnFocus;
    this.returnFocus = undefined;
    const epoch = this.visibilityEpoch;
    try {
      if (
        this.options.platform === "darwin" &&
        !this.options.hiddenTestMode &&
        window &&
        !window.isDestroyed() &&
        window.isVisible() &&
        window.isFocused() &&
        (reason === "toggle-hide" ||
          reason === "ipc-hide" ||
          reason === "native-close" ||
          reason === "capture-hide")
      )
        returnFocus?.();
    } catch (error) {
      this.options.onError?.(error, "returnFocus");
    } finally {
      if (epoch === this.visibilityEpoch && window === this.window && window && !window.isDestroyed())
        window.hide();
    }
  }
  async call(method: unknown, args: unknown): Promise<Result<unknown>> {
    try {
      if (this.disposed) throw new Error("busy: 快速对话正在关闭");
      if (typeof method !== "string" || !Array.isArray(args)) throw new Error("invalid_input: 未知 IPC 方法");
      const counts: Record<string, number | number[]> = {
        takeDraftInput: 1,
        getSnapshot: 0,
        send: [1, 2, 3],
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
        rendererCommitted: 2,
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
        case "takeDraftInput": {
          const sessionId = text(256);
          const pending = this.draftInput;
          if (!pending || sessionId !== pending.sessionId) break;
          this.draftInput = undefined;
          if (pending.epoch === this.visibilityEpoch && this.visible && sessionId === host.sessionId)
            value = pending.input;
          if (value) this.recordEvent("draft-taken");
          break;
        }
        case "rendererCommitted":
        case "rendererReady": {
          const sessionId = text(256);
          const version = args[1];
          if (!Number.isSafeInteger(version) || (version as number) < 0)
            throw new Error("invalid_input: 展示版本无效");
          if (sessionId !== host.sessionId || version !== this.presentationVersion) {
            this.recordEvent("renderer-ack-ignored");
            break;
          }
          if (method === "rendererCommitted") {
            this.recordEvent("renderer-commit");
            break;
          }
          this.recordEvent("renderer-ack");
          this.rendererVersion = version as number;
          this.needsSessionFrame = false;
          if (this.resettingPresentation?.ready) this.resettingPresentation = undefined;
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
          this.recordEvent("composer-reply");
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
          const immediate = args[2];
          if (immediate !== undefined && typeof immediate !== "boolean")
            throw new Error("invalid_input: 发送参数无效");
          if (
            attachments !== undefined &&
            (!Array.isArray(attachments) ||
              attachments.some((id) => typeof id !== "string" || id.length > 256))
          )
            throw new Error("invalid_input: 图片列表参数无效");
          if (immediate) await host.sendNow(text(32_000), attachments as string[] | undefined);
          else host.send(text(32_000), attachments as string[] | undefined);
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
    this.returnFocus = undefined;
    this.draftInput = undefined;
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
