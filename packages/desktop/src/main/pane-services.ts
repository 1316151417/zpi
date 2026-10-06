import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { type BrowserWindow, session, WebContentsView } from "electron";
import type { IPty } from "node-pty";
import type { BrowserState, PaneBounds, PaneEvent } from "../shared/bridge.ts";
import { browserUrl } from "./browser-url.ts";
export class PaneServices {
  private terminals = new Map<string, IPty>();
  private browsers = new Map<string, { view: WebContentsView; error?: string }>();
  private shown?: string;
  private window: BrowserWindow;
  private emit: (event: PaneEvent) => void;
  constructor(window: BrowserWindow, emit: (event: PaneEvent) => void) {
    this.window = window;
    this.emit = emit;
  }
  async createTerminal(cwd: string) {
    if (this.terminals.size >= 12) throw new Error("busy: 请先关闭部分终端");
    const { spawn } = await import("node-pty");
    const shell = process.env.SHELL || "/bin/zsh";
    const env = Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
    );
    delete env.ELECTRON_RUN_AS_NODE;
    const pty = spawn(shell, ["-l"], {
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
    return { id, shell: basename(shell) };
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
    const url = input === "" ? "" : browserUrl(input);
    if (this.browsers.size >= 12) throw new Error("busy: 请先关闭部分浏览器标签");
    const id = randomUUID();
    const isolated = session.fromPartition("persist:ZPI-browser");
    isolated.setPermissionRequestHandler((_, __, callback) => callback(false));
    isolated.setPermissionCheckHandler(() => false);
    const view = new WebContentsView({
      webPreferences: {
        session: isolated,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        navigateOnDragDrop: false,
      },
    });
    this.browsers.set(id, { view });
    const content = view.webContents;
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
    if (url) void this.navigate(id, url);
    return { ...this.browserState(id), url };
  }
  private browser(id: string) {
    const entry = this.browsers.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error("not_found: 浏览器标签已关闭");
    return entry;
  }
  private browserState(id: string): BrowserState {
    const { view, error } = this.browser(id),
      content = view.webContents;
    return {
      id,
      url: content.getURL(),
      title: content.getTitle(),
      loading: content.isLoading(),
      back: content.navigationHistory.getActiveIndex() > 0,
      forward:
        content.navigationHistory.getActiveIndex() + 1 < content.navigationHistory.getAllEntries().length,
      error,
    };
  }
  private async navigate(id: string, url: string) {
    const target = browserUrl(url),
      entry = this.browser(id);
    entry.error = undefined;
    try {
      await entry.view.webContents.loadURL(target);
    } catch (error) {
      if (String(error).includes("ERR_ABORTED")) return;
      if (this.browsers.has(id) && !entry.view.webContents.isDestroyed()) {
        entry.error = String(error);
        this.emit({ type: "browser", state: this.browserState(id) });
      }
    }
  }
  action(id: string, action: string, url?: string) {
    const content = this.browser(id).view.webContents;
    if (action === "navigate" && typeof url === "string") {
      const target = browserUrl(url);
      void this.navigate(id, target);
      return;
    }
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
  bounds(id: string, bounds: PaneBounds | null) {
    if (bounds === null && !this.browsers.has(id)) return;
    const { view } = this.browser(id);
    if (bounds === null) {
      if (this.shown === id) {
        this.window.contentView.removeChildView(view);
        this.shown = undefined;
      }
      return;
    }
    const { width, height } = this.window.getContentBounds();
    if (
      !bounds ||
      Object.keys(bounds).some((k) => !["x", "y", "width", "height"].includes(k)) ||
      [bounds.x, bounds.y, bounds.width, bounds.height].some((n) => !Number.isFinite(n)) ||
      bounds.x < 0 ||
      bounds.y < 0 ||
      bounds.width < 0 ||
      bounds.height < 0
    )
      throw new Error("invalid_input: 浏览器视口无效");
    if (this.shown && this.shown !== id)
      this.window.contentView.removeChildView(this.browser(this.shown).view);
    if (this.shown !== id) this.window.contentView.addChildView(view);
    this.shown = id;
    const zoom = this.window.webContents.getZoomFactor();
    const x = Math.min(width, Math.round(bounds.x * zoom)),
      y = Math.min(height, Math.round(bounds.y * zoom));
    view.setBounds({
      x,
      y,
      width: Math.max(0, Math.min(width - x, Math.floor(bounds.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.floor(bounds.height * zoom))),
    });
  }
  closeBrowser(id: string) {
    const entry = this.browsers.get(id);
    if (!entry) return;
    if (this.shown === id) {
      this.window.contentView.removeChildView(entry.view);
      this.shown = undefined;
    }
    this.browsers.delete(id);
    entry.view.webContents.close({ waitForBeforeUnload: false });
  }
  close() {
    for (const id of this.terminals.keys()) this.closeTerminal(id);
    for (const id of this.browsers.keys()) this.closeBrowser(id);
  }
}
