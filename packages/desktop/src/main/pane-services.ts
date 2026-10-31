import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { type BrowserWindow, session, type WebContents, type WebPreferences, webContents } from "electron";
import type { IPty } from "node-pty";
import type { BrowserState, PaneEvent } from "../shared/bridge.ts";
import type { ShortcutKeyEvent } from "../shared/shortcuts.ts";
import { browserUrl } from "./browser-url.ts";
import type { ShortcutModifier } from "./shortcut-modifier.ts";
import { readTerminalProfile } from "./terminal-profile.ts";
import { terminalShell } from "./terminal-shell.ts";
export class PaneServices {
  private disposed = false;
  private epoch = 0;
  private terminals = new Map<string, IPty>();
  private browsers = new Map<
    string,
    { content?: WebContents; url: string; visible: boolean; error?: string }
  >();
  private window: BrowserWindow;
  private emit: (event: PaneEvent) => void;
  private shortcut: (event: ShortcutKeyEvent) => boolean;
  private modifier?: ShortcutModifier;
  constructor(
    window: BrowserWindow,
    emit: (event: PaneEvent) => void,
    shortcut: (event: ShortcutKeyEvent) => boolean = () => false,
    modifier?: ShortcutModifier,
  ) {
    this.window = window;
    this.emit = emit;
    this.shortcut = shortcut;
    this.modifier = modifier;
  }
  async createTerminal(cwd: string) {
    const epoch = this.epoch;
    if (this.disposed) throw new Error("not_found: 窗口已关闭");
    if (this.terminals.size >= 12) throw new Error("busy: 请先关闭部分终端");
    const [{ spawn }, profile] = await Promise.all([import("node-pty"), readTerminalProfile()]);
    if (this.disposed || epoch !== this.epoch) throw new Error("not_found: 窗口已关闭或重载");
    if (this.terminals.size >= 12) throw new Error("busy: 请先关闭部分终端");
    const { shell, args } = terminalShell();
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const pty = spawn(shell, args, {
      name: "xterm-256color",
      cwd,
      cols: 80,
      rows: 24,
      env: { ...env, TERM: "xterm-256color" },
    });
    const id = randomUUID();
    this.terminals.set(id, pty);
    pty.onData((data) => {
      if (this.terminals.has(id)) this.emit({ type: "terminal", id, data });
    });
    pty.onExit(({ exitCode }) => {
      if (!this.terminals.delete(id)) return;
      this.emit({ type: "terminal", id, data: `\r\n[终端已退出 ${exitCode}]\r\n`, exited: true });
    });
    return { id, shell: basename(shell), profile };
  }
  terminalInput(id: string, data: string) {
    if (typeof data !== "string" || Buffer.byteLength(data) > 1024 * 1024)
      throw new Error("invalid_input: 终端输入超限");
    const pty = this.terminals.get(id);
    if (!pty) throw new Error("not_found: 终端已关闭");
    pty.write(data);
  }
  resizeTerminal(id: string, cols: number, rows: number) {
    if (
      !Number.isSafeInteger(cols) ||
      !Number.isSafeInteger(rows) ||
      cols < 2 ||
      rows < 1 ||
      cols > 1000 ||
      rows > 1000
    )
      throw new Error("invalid_input: 终端尺寸无效");
    this.terminals.get(id)?.resize(cols, rows);
  }
  closeTerminal(id: string) {
    const pty = this.terminals.get(id);
    this.terminals.delete(id);
    pty?.kill();
  }
  createBrowser(input: string): BrowserState {
    if (this.disposed) throw new Error("not_found: 窗口已关闭");
    const url = input === "" ? "" : browserUrl(input);
    if (this.browsers.size >= 12) throw new Error("busy: 请先关闭部分浏览器标签");
    const id = randomUUID();
    this.browsers.set(id, { url, visible: false });
    return this.browserState(id);
  }
  prepareBrowserGuest(preferences: WebPreferences, params: Record<string, string>): boolean {
    if (this.disposed || params.src !== "about:blank" || params.partition !== "persist:zpi-browser")
      return false;
    const isolated = session.fromPartition("persist:zpi-browser");
    isolated.setPermissionRequestHandler((_, __, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    // webview 参与 DOM 合成，菜单不再需要移除整页；guest 仍不能继承宿主的特权配置。
    delete preferences.preload;
    delete params.preload;
    delete params.nodeintegration;
    delete params.nodeintegrationinsubframes;
    delete params.disablewebsecurity;
    Object.assign(preferences, {
      session: isolated,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      navigateOnDragDrop: false,
      ...(process.env.ZPI_TEST_MODE === "1"
        ? {
            devTools: false,
            disableDialogs: true,
            disableHtmlFullscreenWindowResize: true,
            backgroundThrottling: false,
          }
        : {}),
    });
    return true;
  }
  attachBrowserGuest(id: string, webContentsId: number, visible: boolean) {
    const entry = this.browser(id);
    if (!Number.isSafeInteger(webContentsId) || typeof visible !== "boolean")
      throw new Error("invalid_input: 浏览器 guest 无效");
    const content = webContents.fromId(webContentsId);
    if (
      !content ||
      content.isDestroyed() ||
      content.getType() !== "webview" ||
      content.hostWebContents !== this.window.webContents ||
      content.session !== session.fromPartition("persist:zpi-browser") ||
      (entry.content && entry.content !== content) ||
      [...this.browsers.values()].some((other) => other !== entry && other.content === content)
    )
      throw new Error("invalid_input: 浏览器 guest 不属于此标签或窗口");
    entry.visible = visible;
    if (!visible) this.modifier?.resetFor(content);
    // dom-ready 会随导航重复发生，只绑定一次，不能重复导航或丢失网页状态。
    if (entry.content === content) return;
    entry.content = content;
    this.modifier?.observe(content);
    content.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown") return;
      if (
        this.shortcut({
          key: input.key,
          code: input.code,
          ctrlKey: input.control,
          metaKey: input.meta,
          altKey: input.alt,
          shiftKey: input.shift,
          repeat: input.isAutoRepeat,
          isComposing: input.isComposing,
        })
      )
        event.preventDefault();
    });
    content.on("will-navigate", (event, target) => {
      try {
        browserUrl(target);
      } catch {
        event.preventDefault();
      }
    });
    content.on("will-redirect", (event, target) => {
      try {
        browserUrl(target);
      } catch {
        event.preventDefault();
      }
    });
    content.setWindowOpenHandler(({ url }) => {
      try {
        const target = browserUrl(url);
        void this.navigate(id, target);
      } catch {
        /* Unsupported scheme. */
      }
      return { action: "deny" };
    });
    const update = () => {
      if (this.browsers.has(id) && !content.isDestroyed())
        this.emit({ type: "browser", state: this.browserState(id) });
    };
    content.on("did-start-loading", () => {
      const entry = this.browsers.get(id);
      if (entry) entry.error = undefined;
      update();
    });
    content.on("did-stop-loading", update);
    content.on("did-navigate", update);
    content.on("did-navigate-in-page", update);
    content.on("page-title-updated", update);
    content.on("did-fail-load", (_, code, description, __, mainFrame) => {
      if (mainFrame && code !== -3) {
        const entry = this.browsers.get(id);
        if (entry) entry.error = description;
        update();
      }
    });
    content.on("render-process-gone", () => {
      const entry = this.browsers.get(id);
      if (entry) {
        entry.error = "页面进程已退出，请刷新";
        update();
      }
    });
    if (entry.url) void this.navigate(id, entry.url);
  }
  private browser(id: string) {
    const entry = this.browsers.get(id);
    if (!entry) throw new Error("not_found: 浏览器标签已关闭");
    return entry;
  }
  private browserState(id: string): BrowserState {
    const { content, url, error } = this.browser(id);
    const live = content && !content.isDestroyed() ? content : undefined;
    const currentUrl = live?.getURL();
    return {
      id,
      url: currentUrl && currentUrl !== "about:blank" ? currentUrl : url,
      title: live?.getTitle() ?? "",
      loading: live?.isLoading() ?? false,
      back: (live?.navigationHistory.getActiveIndex() ?? 0) > 0,
      forward: live
        ? live.navigationHistory.getActiveIndex() + 1 < live.navigationHistory.getAllEntries().length
        : false,
      error,
    };
  }
  private async navigate(id: string, url: string) {
    const target = browserUrl(url),
      entry = this.browser(id);
    entry.error = undefined;
    entry.url = target;
    if (!entry.content) {
      this.emit({ type: "browser", state: this.browserState(id) });
      return;
    }
    try {
      await entry.content.loadURL(target);
    } catch (error) {
      if (String(error).includes("ERR_ABORTED")) return;
      if (this.browsers.has(id) && !entry.content.isDestroyed()) {
        entry.error = String(error);
        this.emit({ type: "browser", state: this.browserState(id) });
      }
    }
  }
  action(id: string, action: string, url?: string) {
    const entry = this.browser(id);
    if (
      !["navigate", "back", "forward", "reload", "stop"].includes(action) ||
      (action === "navigate" && typeof url !== "string")
    )
      throw new Error("invalid_input: 浏览器操作无效");
    if (action === "navigate" && typeof url === "string") {
      const target = browserUrl(url);
      void this.navigate(id, target);
      return;
    }
    const content = entry.content;
    if (!content) return;
    if (content.isDestroyed()) throw new Error("not_found: 浏览器标签已关闭");
    if (action === "back" && content.navigationHistory.getActiveIndex() > 0)
      content.navigationHistory.goToIndex(content.navigationHistory.getActiveIndex() - 1);
    else if (
      action === "forward" &&
      content.navigationHistory.getActiveIndex() + 1 < content.navigationHistory.getAllEntries().length
    )
      content.navigationHistory.goToIndex(content.navigationHistory.getActiveIndex() + 1);
    else if (action === "reload") content.reload();
    else if (action === "stop") content.stop();
    else if (!["back", "forward"].includes(action)) throw new Error("invalid_input: 浏览器操作无效");
  }
  hasFocusedBrowser(): boolean {
    return [...this.browsers.values()].some(
      ({ content, visible }) => visible && content && !content.isDestroyed() && content.isFocused(),
    );
  }
  closeBrowser(id: string) {
    const entry = this.browsers.get(id);
    if (!entry) return;
    this.browsers.delete(id);
    if (entry.content && !entry.content.isDestroyed()) {
      this.modifier?.resetFor(entry.content);
      entry.content.close({ waitForBeforeUnload: false });
    }
  }
  reset() {
    this.epoch++;
    for (const id of this.terminals.keys()) this.closeTerminal(id);
    for (const id of this.browsers.keys()) this.closeBrowser(id);
  }
  close() {
    this.disposed = true;
    this.reset();
  }
}
