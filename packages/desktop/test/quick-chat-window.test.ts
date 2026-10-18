import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, test, vi } from "vitest";
import type { QuickChatHost } from "../src/main/quick-chat-host.ts";
import { resumeQuickChatExpanded } from "../src/main/quick-chat-presentation.ts";
import type { QuickChatTiming } from "../src/main/quick-chat-timing.ts";
import { installQuickChatIpc, QuickChatWindow } from "../src/main/quick-chat-window.ts";
import type { QuickChatSnapshot } from "../src/shared/quick-chat.ts";

function fixture(
  options: {
    autoLoad?: boolean;
    hidden?: boolean;
    platform?: NodeJS.Platform;
    history?: boolean;
    timing?: QuickChatTiming;
  } = {},
) {
  let snapshot = {
    revision: 1,
    session: { sessionId: "session-1", runs: options.history ? [{}] : [] },
  } as QuickChatSnapshot;
  let listener: (snapshot: QuickChatSnapshot) => void = () => {};
  let spaceChanged = () => {};
  const workspaceNotifications = {
    subscribeWorkspaceNotification: vi.fn((_name: string, callback: () => void) => {
      spaceChanged = callback;
      return 0;
    }),
    unsubscribeWorkspaceNotification: vi.fn(),
  };
  const getDisplay = vi.fn(() => ({
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    workArea: { x: 0, y: 25, width: 1440, height: 825 },
  }));
  const host = {
    subscribe: vi.fn((callback: typeof listener) => {
      listener = callback;
      return vi.fn();
    }),
    refreshSettings: vi.fn(),
    close: vi.fn(async () => {}),
    getSnapshot: vi.fn(() => snapshot),
    send: vi.fn(),
    importAttachment: vi.fn(async () => ({ id: "image-1" })),
    readAttachment: vi.fn(async () => ({ metadata: { id: "image-1" }, data: "image-bytes" })),
    removeAttachment: vi.fn(async () => {}),
    discardDraftAttachments: vi.fn(),
    stop: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    resetIfExpired: vi.fn<() => Promise<void> | undefined>(() => undefined),
    get sessionId() {
      return snapshot.session.sessionId;
    },
    readWebSourceIcon: vi.fn(async () => undefined as string | undefined),
  };
  const windows: ReturnType<typeof makeWindow>[] = [];
  const configs: BrowserWindowConstructorOptions[] = [];
  const copyText = vi.fn();
  const activateApp = vi.fn();
  const onError = vi.fn();
  const openExternal = vi.fn(async () => {});
  function makeWindow(config: BrowserWindowConstructorOptions) {
    let bounds = { x: config.x ?? 0, y: config.y ?? 0, width: config.width ?? 0, height: config.height ?? 0 };
    let focused = false;
    let visible = false;
    let destroyed = false;
    let url = "";
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(),
      setPermissionCheckHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
    });
    const contents = Object.assign(new EventEmitter(), {
      session,
      isDestroyed: () => destroyed,
      mainFrame: {},
      getURL: () => url,
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
      importAttachment: vi.fn(async () => ({ id: "image-1" })),
      readAttachment: vi.fn(async () => ({ metadata: { id: "image-1" }, data: "image-bytes" })),
      removeAttachment: vi.fn(async () => {}),
      discardDraftAttachments: vi.fn(),
    });
    const window = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => destroyed,
      isMinimized: vi.fn(() => false),
      getBounds: () => ({ ...bounds }),
      setBounds: vi.fn((next) => {
        bounds = { ...next };
      }),
      setMinimumSize: vi.fn(),
      isFocused: vi.fn(() => focused),
      isVisible: vi.fn(() => visible),
      blur: () => {
        focused = false;
        window.emit("blur");
      },
      show: vi.fn(() => {
        visible = true;
        window.emit("show");
      }),
      focus: vi.fn(() => {
        focused = true;
        window.emit("focus");
      }),
      restore: vi.fn(),
      hide: vi.fn(() => {
        focused = false;
        visible = false;
        window.emit("hide");
      }),
      destroy: vi.fn(() => {
        destroyed = true;
        contents.emit("destroyed");
        window.emit("closed");
      }),
      loadURL: vi.fn(async (next: string) => {
        url = next;
        if (options.autoLoad !== false) queueMicrotask(() => contents.emit("did-finish-load"));
      }),
    });
    return window;
  }
  const quick = new QuickChatWindow({
    host: host as unknown as QuickChatHost,
    timing: options.timing,
    createWindow: (config) => {
      configs.push(config);
      const window = makeWindow(config);
      windows.push(window);
      return window as unknown as BrowserWindow;
    },
    rendererUrl: "file:///app/renderer/quick-chat.html",
    preload: "/app/preload/quick-chat.cjs",
    hiddenTestMode: options.hidden ?? false,
    platform: options.platform ?? "linux",
    getDisplay,
    workspaceNotifications,
    copyText,
    activateApp,
    openExternal,
    onError,
    loadSourceIcon: vi.fn(async () => undefined),
  });
  return {
    quick,
    host,
    windows,
    configs,
    copyText,
    activateApp,
    openExternal,
    onError,
    getDisplay,
    workspaceNotifications,
    spaceChanged: () => spaceChanged(),
    rendererReady: async (sessionId = host.sessionId, version?: number) => {
      const result = await quick.call("getSnapshot", []);
      if (!result.ok) return result;
      return quick.call("rendererReady", [
        sessionId,
        version ?? (result.value as QuickChatSnapshot).presentationVersion,
      ]);
    },
    changeSession: (id: string) => {
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        session: { sessionId: id, title: "快速对话", seq: 0, runs: [] },
      } as QuickChatSnapshot;
      listener(snapshot);
    },
    emitHistory: (history: boolean) => {
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        session: { sessionId: snapshot.session.sessionId, runs: history ? [{}] : [] },
      } as QuickChatSnapshot;
      listener(snapshot);
      const published = windows.at(-1)?.webContents.send.mock.calls.at(-1)?.[1] as
        | QuickChatSnapshot
        | undefined;
      if (published?.presentationVersion !== undefined)
        void quick.call("rendererReady", [host.sessionId, published.presentationVersion]);
    },
  };
}

test("retains original IPC failures for diagnostics without depending on the logger", async () => {
  const f = fixture();
  const error = new Error("provider: private diagnostic");
  f.host.send.mockImplementation(() => {
    throw error;
  });
  await expect(f.quick.call("send", ["hello"])).resolves.toMatchObject({ ok: false });
  expect(f.onError).toHaveBeenCalledWith(error, "send");
  f.onError.mockImplementation(() => {
    throw new Error("logger unavailable");
  });
  await expect(f.quick.call("send", ["hello"])).resolves.toMatchObject({
    ok: false,
    error: { code: "provider", message: error.message },
  });
  await f.quick.dispose();
});

test("captured content is handed to the active renderer once and invalidated by hide or reset", async () => {
  const f = fixture();
  await f.quick.openWithDraft({ text: "captured" }, f.host.sessionId);
  expect(f.windows[0].isVisible()).toBe(true);
  expect(f.windows[0].webContents.send).toHaveBeenCalledWith("zpi:quick-chat-draft");
  await expect(f.quick.call("takeDraftInput", ["wrong-session"])).resolves.toMatchObject({
    ok: true,
    value: undefined,
  });
  await expect(f.quick.call("takeDraftInput", [f.host.sessionId])).resolves.toEqual({
    ok: true,
    value: { text: "captured" },
  });
  await expect(f.quick.call("takeDraftInput", [f.host.sessionId])).resolves.toMatchObject({
    ok: true,
    value: undefined,
  });
  await f.quick.openWithDraft({ text: "hidden" }, f.host.sessionId);
  f.quick.hide();
  await expect(f.quick.call("takeDraftInput", [f.host.sessionId])).resolves.toMatchObject({
    ok: true,
    value: undefined,
  });
  f.changeSession("next");
  await f.quick.openWithDraft({ text: "stale" }, "session-1");
  expect(f.windows[0].isVisible()).toBe(false);
  expect(f.host.send).not.toHaveBeenCalled();
  expect(f.host.reset).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("quick window is lazy, isolated, and toggles without affecting its request or the main task", async () => {
  const f = fixture();
  expect(f.windows).toHaveLength(0);
  await f.quick.toggle();
  expect(f.windows).toHaveLength(1);
  const window = f.windows[0];
  expect(f.configs[0]).toMatchObject({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    backgroundColor: "#00000000",
    alwaysOnTop: true,
    webPreferences: {
      preload: "/app/preload/quick-chat.cjs",
      partition: "zpi-quick-chat",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  expect(window.loadURL).toHaveBeenCalledWith("file:///app/renderer/quick-chat.html?view=quick-chat");
  expect(window.show).toHaveBeenCalledTimes(1);
  await f.quick.toggle();
  expect(window.hide).toHaveBeenCalledTimes(1);
  expect(f.host.stop).not.toHaveBeenCalled();
  expect(f.host.reset).not.toHaveBeenCalled();
  await f.quick.toggle();
  expect(f.windows).toHaveLength(1);
  expect(window.show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
  expect(f.host.close).toHaveBeenCalledOnce();
});

test("opening an already visible quick chat does not expire its session", async () => {
  const f = fixture();
  await f.quick.show();
  f.host.resetIfExpired.mockClear();
  await f.quick.show();
  expect(f.host.resetIfExpired).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("a reloaded hidden renderer must acknowledge its new frame before being shown", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  const window = f.windows[0];
  f.quick.hide();
  window.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: window.webContents.getURL(),
  });
  const opening = f.quick.show();
  await Promise.resolve();
  expect(window.show).toHaveBeenCalledTimes(1);
  await f.rendererReady();
  await opening;
  expect(window.show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("repeated toggles while loading preserve the latest visibility intent", async () => {
  const f = fixture({ autoLoad: false });
  const first = f.quick.toggle();
  await f.quick.toggle();
  f.windows[0].webContents.emit("did-finish-load");
  await first;
  expect(f.windows[0].show).not.toHaveBeenCalled();
  await f.quick.toggle();
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("compact opens as an input-sized window, expands only once, and preserves expanded history until reset", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  expect(f.configs[0]).toMatchObject({ width: 360, height: 44, minHeight: 44, resizable: false });
  f.emitHistory(true);
  expect(window.getBounds().height).toBe(560);
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(440, 360);
  window.setBounds.mockClear();
  f.emitHistory(true);
  f.emitHistory(true);
  expect(window.setBounds).not.toHaveBeenCalled();
  f.quick.hide();
  await f.quick.show();
  expect(window.getBounds()).toMatchObject({ width: 660, height: 560 });
  f.emitHistory(false);
  expect(window.getBounds().height).toBe(44);
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(360, 44);
  await f.quick.dispose();
});

test("renderer recreation opens expanded from existing host history", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  expect(f.configs[0]).toMatchObject({ height: 560, minHeight: 360, resizable: false });
  f.windows[0].webContents.emit("render-process-gone");
  await f.quick.show();
  expect(f.configs[1]).toMatchObject({ height: 560, minHeight: 360, resizable: false });
  await f.quick.dispose();
});

test("both modes fit a small active display and reopening leaves old display coordinates behind", async () => {
  const f = fixture();
  f.getDisplay.mockReturnValue({
    bounds: { x: -500, y: -200, width: 380, height: 300 },
    workArea: { x: -500, y: -200, width: 380, height: 300 },
  });
  await f.quick.show();
  const window = f.windows[0];
  expect(window.getBounds()).toMatchObject({ x: -490, width: 360, height: 44 });
  f.emitHistory(true);
  expect(window.getBounds()).toEqual({ x: -500, y: -200, width: 380, height: 300 });
  f.quick.hide();
  f.getDisplay.mockReturnValue({
    bounds: { x: 1440, y: 0, width: 1000, height: 800 },
    workArea: { x: 1440, y: 50, width: 1000, height: 700 },
  });
  await f.quick.show();
  const bounds = window.getBounds();
  expect(bounds).toMatchObject({ width: 660, height: 560 });
  expect(bounds.x).toBeGreaterThanOrEqual(1440);
  expect(bounds.y).toBeGreaterThanOrEqual(50);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(2440);
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(750);
  await f.quick.dispose();
});

test("macOS activates the app after showing its panel even when the native window already reports key focus", async () => {
  const f = fixture({ platform: "darwin" });
  await f.quick.prepare();
  const window = f.windows[0];
  const calls: string[] = [];
  window.show.mockImplementation(() => calls.push("show"));
  window.isFocused.mockReturnValue(true);
  f.activateApp.mockImplementation(() => calls.push("activate"));
  window.focus.mockImplementation(() => calls.push("focus"));
  await f.quick.show();
  expect(calls).toEqual(["show", "activate", "focus"]);
  await f.quick.dispose();
});

test("macOS uses an unparented all-Spaces panel and visible-but-unfocused toggle brings it forward", async () => {
  const f = fixture({ platform: "darwin" });
  await f.quick.toggle();
  const window = f.windows[0];
  expect(f.configs[0]).toMatchObject({ type: "panel", hiddenInMissionControl: true });
  expect(f.configs[0]).not.toHaveProperty("parent");
  // It may still be OS-visible on another Space, or focus may have changed
  // before the blur notification. Visibility alone must not mean "hide".
  window.isFocused.mockReturnValue(false);
  f.getDisplay.mockReturnValue({
    bounds: { x: 1440, y: 0, width: 1000, height: 700 },
    workArea: { x: 1440, y: 0, width: 1000, height: 700 },
  });
  await f.quick.toggle();
  expect(window.show).toHaveBeenCalledTimes(2);
  expect(window.hide).not.toHaveBeenCalled();
  expect(window.getBounds().x).toBeGreaterThanOrEqual(1440);
  window.isFocused.mockReturnValue(true);
  await f.quick.toggle();
  expect(window.hide).toHaveBeenCalledOnce();
  expect(f.host.stop).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("blur and active Space change hide without cancelling and release the native subscription exactly once", async () => {
  const f = fixture({ platform: "darwin" });
  expect(f.workspaceNotifications.subscribeWorkspaceNotification).toHaveBeenCalledExactlyOnceWith(
    "NSWorkspaceActiveSpaceDidChangeNotification",
    expect.any(Function),
  );
  await f.quick.show();
  const window = f.windows[0];
  window.blur();
  expect(window.hide).toHaveBeenCalledOnce();
  await f.quick.show();
  expect(window.isFocused()).toBe(true);
  f.spaceChanged();
  expect(window.hide).toHaveBeenCalledTimes(2);
  expect(f.host.stop).not.toHaveBeenCalled();
  expect(f.host.reset).not.toHaveBeenCalled();
  await f.quick.show();
  await f.quick.dispose();
  await f.quick.dispose();
  expect(f.workspaceNotifications.unsubscribeWorkspaceNotification).toHaveBeenCalledExactlyOnceWith(0);
  f.spaceChanged();
  expect(window.hide).toHaveBeenCalledTimes(2);
});

test("Space change during renderer loading cancels a pending show, but reopening still succeeds", async () => {
  const f = fixture({ platform: "darwin", autoLoad: false });
  const opening = f.quick.show();
  f.spaceChanged();
  f.windows[0].webContents.emit("did-finish-load");
  await opening;
  expect(f.windows[0].show).not.toHaveBeenCalled();
  await f.quick.show();
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("non-macOS windows do not use panel or subscribe to workspace notifications", async () => {
  const f = fixture({ platform: "win32" });
  await f.quick.show();
  expect(f.configs[0]).not.toHaveProperty("type");
  expect(f.workspaceNotifications.subscribeWorkspaceNotification).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("a Space change during native show does not refocus and resurrect the hidden panel", async () => {
  const f = fixture({ platform: "darwin" });
  await f.quick.show();
  f.quick.hide();
  const window = f.windows[0];
  window.focus.mockClear();
  f.activateApp.mockClear();
  window.show.mockImplementationOnce(() => f.spaceChanged());
  await f.quick.show();
  expect(window.focus).not.toHaveBeenCalled();
  expect(f.activateApp).not.toHaveBeenCalled();
  await f.quick.toggle();
  expect(window.focus).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("a Space change during application activation cancels focus rather than resurrecting the panel", async () => {
  const f = fixture({ platform: "darwin" });
  f.activateApp.mockImplementation(() => f.spaceChanged());
  await f.quick.show();
  expect(f.windows[0].isVisible()).toBe(false);
  expect(f.windows[0].focus).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("hidden macOS automation never activates the application", async () => {
  const f = fixture({ platform: "darwin", hidden: true });
  await f.quick.show();
  expect(f.activateApp).not.toHaveBeenCalled();
  expect(f.windows[0].show).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("native close hides, renderer crash recreates, and quitting destroys without resurrecting a window", async () => {
  const f = fixture();
  await f.quick.show();
  const event = { preventDefault: vi.fn() };
  f.windows[0].emit("close", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
  expect(f.windows[0].hide).toHaveBeenCalledOnce();
  expect(f.host.close).not.toHaveBeenCalled();
  f.windows[0].webContents.emit("render-process-gone");
  await f.quick.show();
  expect(f.windows).toHaveLength(2);
  await f.quick.dispose();
  await f.quick.show();
  expect(f.windows).toHaveLength(2);
  expect(f.host.close).toHaveBeenCalledOnce();
});

test("pending load can be disposed without showing or reusing a dead renderer", async () => {
  const f = fixture({ autoLoad: false });
  const opening = f.quick.show();
  await f.quick.dispose();
  await opening;
  expect(f.windows[0].show).not.toHaveBeenCalled();
  expect(f.windows[0].destroy).toHaveBeenCalledOnce();
});

test("late native events from a crashed renderer cannot hide or toggle a replacement window", async () => {
  const f = fixture();
  await f.quick.show();
  const old = f.windows[0];
  old.webContents.emit("render-process-gone");
  await f.quick.show();
  const replacement = f.windows[1];
  old.emit("close", { preventDefault: vi.fn() });
  old.emit("blur");
  old.emit("hide");
  old.emit("closed");
  expect(replacement.hide).not.toHaveBeenCalled();
  await f.quick.toggle();
  expect(replacement.hide).toHaveBeenCalledOnce();
  expect(replacement.show).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("hidden test mode never shows/focuses a native window", async () => {
  const f = fixture({ hidden: true });
  await f.quick.show();
  expect(f.windows[0].show).not.toHaveBeenCalled();
  expect(f.windows[0].focus).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("dedicated IPC rejects other renderers and child frames before dispatch", async () => {
  const f = fixture();
  await f.quick.show();
  const handle = vi.fn();
  const removeHandler = vi.fn();
  const remove = installQuickChatIpc({ handle, removeHandler } as unknown as IpcMain, f.quick);
  const handler = handle.mock.calls[0][1] as (
    event: unknown,
    method: string,
    args: unknown[],
  ) => Promise<unknown>;
  const contents = f.windows[0].webContents;
  for (const event of [
    { sender: {}, senderFrame: {} },
    { sender: contents, senderFrame: {} },
  ]) {
    expect(await handler(event, "send", ["intrusion"])).toMatchObject({ ok: false });
  }
  expect(f.host.send).not.toHaveBeenCalled();
  const event = { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent;
  expect(await handler(event, "send", ["hello"])).toEqual({ ok: true, value: undefined });
  expect(f.host.send).toHaveBeenCalledWith("hello", undefined);
  for (const method of [
    "createSession",
    "setSelection",
    "saveQuickChatSettings",
    "startRun",
    "createBrowser",
    "terminalInput",
    "getProviderCredentials",
    "__proto__",
    "constructor",
  ]) {
    expect(await handler(event, method, [])).toMatchObject({ ok: false });
  }
  expect(await handler(event, "send", ["one", "two"])).toMatchObject({ ok: false });
  remove();
  expect(removeHandler).toHaveBeenCalledWith("zpi:quick-chat");
  await f.quick.dispose();
  expect(f.quick.owns(event)).toBe(false);
});

test("renderer network and local-file loading fail closed outside bundled assets", async () => {
  const f = fixture();
  await f.quick.show();
  const session = f.windows[0].webContents.session;
  const filter = session.webRequest.onBeforeRequest.mock.calls[0][0] as (
    details: { url: string },
    callback: (result: { cancel: boolean }) => void,
  ) => void;
  for (const url of [
    "https://tracking.example/image.png",
    "http://127.0.0.1/secret",
    "file:///home/user/.ssh/id_rsa",
    "file:///app/renderer/../outside.png",
    "bad url",
  ]) {
    const callback = vi.fn();
    filter({ url }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  }
  for (const url of [
    "file:///app/renderer/quick-chat.html?view=quick-chat",
    "file:///app/renderer/assets/app.js",
    "data:image/png;base64,AA",
  ]) {
    const callback = vi.fn();
    filter({ url }, callback);
    expect(callback).toHaveBeenCalledWith({ cancel: false });
  }
  const permission = session.setPermissionRequestHandler.mock.calls[0][0] as (
    contents: unknown,
    permission: string,
    callback: (allowed: boolean) => void,
  ) => void;
  const reply = vi.fn();
  permission({}, "microphone", reply);
  expect(reply).toHaveBeenCalledWith(false);
  await f.quick.dispose();
});

test("user link actions allow only HTTP(S) and clipboard payloads remain bounded", async () => {
  const f = fixture();
  for (const url of ["file:///secret", "javascript:alert(1)", "https://user:secret@example.com", "bad url"]) {
    expect(await f.quick.call("openExternal", [url])).toMatchObject({ ok: false });
  }
  expect(f.openExternal).not.toHaveBeenCalled();
  expect(await f.quick.call("openExternal", ["https://example.com/article"])).toMatchObject({ ok: true });
  expect(f.openExternal).toHaveBeenCalledWith("https://example.com/article");
  expect(await f.quick.call("copyText", ["answer"])).toMatchObject({ ok: true });
  expect(f.copyText).toHaveBeenCalledWith("answer");
  expect(await f.quick.call("copyText", ["x".repeat(1_000_001)])).toMatchObject({ ok: false });
  await f.quick.dispose();
});

test("hidden preparation shares cold loading without showing, expiring, refreshing or starting a run", async () => {
  const f = fixture({ autoLoad: false });
  const warm = f.quick.prepare();
  const again = f.quick.prepare();
  expect(f.windows).toHaveLength(1);
  expect(f.host.resetIfExpired).not.toHaveBeenCalled();
  expect(f.host.refreshSettings).not.toHaveBeenCalled();
  expect(f.host.send).not.toHaveBeenCalled();
  const opening = f.quick.show();
  f.windows[0].webContents.emit("did-finish-load");
  await Promise.all([warm, again, opening]);
  expect(f.windows[0].loadURL).toHaveBeenCalledOnce();
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  expect(f.host.resetIfExpired).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("delayed warmup stays hidden, is idempotent, and is cancelled on disposal", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture();
    const error = vi.fn();
    f.quick.scheduleWarmup(error);
    f.quick.scheduleWarmup(error);
    expect(f.windows).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1500);
    expect(f.windows).toHaveLength(1);
    expect(f.windows[0].show).not.toHaveBeenCalled();
    expect(f.windows[0].focus).not.toHaveBeenCalled();
    expect(f.host.resetIfExpired).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    await f.quick.dispose();
    const cancelled = fixture();
    cancelled.quick.scheduleWarmup(error);
    await cancelled.quick.dispose();
    await vi.advanceTimersByTimeAsync(1500);
    expect(cancelled.windows).toHaveLength(0);
  } finally {
    vi.useRealTimers();
  }
});

test("Space change or toggle while an expired run is stopping cancels the pending show", async () => {
  const f = fixture({ platform: "darwin" });
  await f.quick.prepare();
  await f.rendererReady("session-1");
  let expired!: () => void;
  f.host.resetIfExpired.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        expired = resolve;
      }),
  );
  const opening = f.quick.show();
  await f.quick.toggle();
  expired();
  await opening;
  expect(f.windows[0].show).not.toHaveBeenCalled();
  await f.quick.show();
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  f.quick.hide();
  f.host.resetIfExpired.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        expired = resolve;
      }),
  );
  const afterSpace = f.quick.show();
  f.spaceChanged();
  expired();
  await afterSpace;
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test.each([
  {
    name: "bottom Dock",
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    area: { x: 0, y: 25, width: 1440, height: 825 },
    x: 540,
    bottom: 800,
  },
  {
    name: "side Dock",
    bounds: { x: -1440, y: -100, width: 1440, height: 900 },
    area: { x: -1360, y: -75, width: 1360, height: 875 },
    x: -900,
    bottom: 736,
  },
  {
    name: "auto-hidden Dock",
    bounds: { x: 0, y: 0, width: 1440, height: 900 },
    area: { x: 0, y: 25, width: 1440, height: 873 },
    x: 540,
    bottom: 834,
  },
])(
  "$name uses only DIP geometry and keeps the same bottom anchor after expansion",
  async ({ bounds, area, x, bottom }) => {
    const f = fixture();
    f.getDisplay.mockReturnValue({ bounds, workArea: area });
    await f.quick.show();
    const window = f.windows[0];
    expect(window.getBounds()).toEqual({ x, y: bottom - 44, width: 360, height: 44 });
    await f.quick.call("setNoticeHeight", ["session-1", 172]);
    expect(window.getBounds()).toEqual({ x, y: bottom - 216, width: 360, height: 216 });
    await f.quick.call("setNoticeHeight", ["session-1", 0]);
    expect(window.getBounds()).toEqual({ x, y: bottom - 44, width: 360, height: 44 });
    f.emitHistory(true);
    expect(window.getBounds().y + window.getBounds().height).toBe(bottom);
    expect(window.getBounds().x + window.getBounds().width / 2).toBe(bounds.x + bounds.width / 2);
    await f.quick.dispose();
  },
);

test("source icon IPC delegates only bounded session/run/source fields to the quick host", async () => {
  const f = fixture();
  f.host.readWebSourceIcon.mockResolvedValue("data:image/png;base64,SAFE");
  expect(await f.quick.call("readWebSourceIcon", ["session", "run", "https://example.com/article"])).toEqual({
    ok: true,
    value: { dataUrl: "data:image/png;base64,SAFE" },
  });
  expect(f.host.readWebSourceIcon).toHaveBeenCalledWith(
    "session",
    "run",
    "https://example.com/article",
    expect.any(Function),
  );
  f.host.readWebSourceIcon.mockClear();
  for (const args of [
    ["s", "r"],
    ["s", "r", "url", "icon"],
    [null, "r", "url"],
    ["s".repeat(257), "r", "url"],
    ["s", "r", "u".repeat(8193)],
  ]) {
    expect(await f.quick.call("readWebSourceIcon", args)).toMatchObject({ ok: false });
  }
  expect(f.host.readWebSourceIcon).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("retained warm invocation shows synchronously without redundant geometry, focus, settings, or IPC", async () => {
  const f = fixture({ history: true });
  await f.quick.prepare();
  const window = f.windows[0];
  window.show.mockImplementation(() => {
    window.isFocused.mockReturnValue(true);
  });
  const opening = f.quick.show();
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).not.toHaveBeenCalled();
  expect(window.setBounds).not.toHaveBeenCalled();
  expect(window.setMinimumSize).not.toHaveBeenCalled();
  expect(f.host.refreshSettings).not.toHaveBeenCalled();
  expect(window.webContents.send).not.toHaveBeenCalled();
  await opening;
  await f.quick.dispose();
});

test("blur during expanded show cannot defeat repeated invocations before focus executes", async () => {
  const f = fixture({ history: true });
  await f.quick.prepare();
  const window = f.windows[0];
  const nativeShow = window.show.getMockImplementation();
  window.show.mockImplementation(() => {
    nativeShow?.();
    window.emit("blur");
  });
  for (let index = 0; index < 3; index++) {
    await f.quick.toggle();
    expect(window.focus).toHaveBeenCalledTimes(index + 1);
    expect(window.hide).toHaveBeenCalledTimes(index);
    expect(window.getBounds().height).toBe(560);
    await f.quick.toggle();
    expect(window.hide).toHaveBeenCalledTimes(index + 1);
  }
  expect(f.host.stop).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("same-window late blur/hide cannot undo a focused reopen, but a real blur still hides", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  await f.quick.show();
  const window = f.windows[0];
  window.emit("blur");
  window.emit("hide");
  await Promise.resolve();
  expect(window.hide).toHaveBeenCalledOnce();
  window.blur();
  expect(window.hide).toHaveBeenCalledTimes(2);
  await f.quick.show();
  expect(window.show).toHaveBeenCalledTimes(3);
  await f.quick.dispose();
});

test("expired show waits for the new rendered session and rejects old acknowledgements", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  f.host.resetIfExpired.mockImplementationOnce(async () => {
    f.changeSession("new-session");
  });
  const opening = f.quick.show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady("session-1");
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady("new-session");
  await opening;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.windows[0].getBounds().height).toBe(44);
  await f.quick.dispose();
});

test("hiding before a new-session frame does not permit a later warm open to flash stale contents", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  f.changeSession("new-session");
  const first = f.quick.show();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.quick.toggle();
  await first;
  const latest = f.quick.toggle();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady("new-session");
  await latest;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("new-session waits release on Space change or disposal without a late acknowledgement reopening", async () => {
  for (const dispose of [false, true]) {
    const f = fixture({ platform: "darwin", history: true });
    await f.quick.show();
    f.quick.hide();
    f.changeSession("replacement");
    const opening = f.quick.show();
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (dispose) await f.quick.dispose();
    else f.spaceChanged();
    await opening;
    await f.rendererReady("replacement");
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    await f.quick.dispose();
  }
});

test("composer growth keeps its bottom anchor, clamps to the screen, and rejects stale or malformed resize", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  const bottom = window.getBounds().y + window.getBounds().height;
  expect(await f.quick.call("setComposerHeight", ["session-1", 140])).toMatchObject({ ok: true });
  expect(window.getBounds().height).toBe(140);
  expect(window.getBounds().y + window.getBounds().height).toBe(bottom);
  window.setBounds.mockClear();
  await f.quick.call("setComposerHeight", ["session-1", 140]);
  await f.quick.call("setComposerHeight", ["old-session", 184]);
  expect(window.setBounds).not.toHaveBeenCalled();
  for (const height of [0, 43, 241, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
    expect(await f.quick.call("setComposerHeight", ["session-1", height])).toMatchObject({ ok: false });
  }
  f.getDisplay.mockReturnValue({
    bounds: { x: 0, y: 0, width: 320, height: 80 },
    workArea: { x: 0, y: 0, width: 320, height: 80 },
  });
  await f.quick.call("setComposerHeight", ["session-1", 184]);
  expect(window.getBounds()).toEqual({ x: 0, y: 0, width: 320, height: 80 });
  f.emitHistory(true);
  const expanded = window.getBounds();
  await f.quick.call("setComposerHeight", ["session-1", 44]);
  expect(window.getBounds()).toEqual(expanded);
  f.changeSession("new-session");
  await f.quick.call("setComposerHeight", ["session-1", 184]);
  expect(window.getBounds().height).toBe(44);
  await f.quick.dispose();
});

test("notice space grows upward independently of the composer and shrinks on close or remeasurement", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  const initial = window.getBounds();
  const bottom = initial.y + initial.height;
  for (const [method, height, total] of [
    ["setNoticeHeight", 52.4, 96],
    ["setComposerHeight", 184, 236],
    ["setNoticeHeight", 172, 356],
    ["setComposerHeight", 240, 412],
    ["setNoticeHeight", 84.6, 325],
    ["setNoticeHeight", 0, 240],
    ["setNoticeHeight", 172, 412],
    ["setComposerHeight", 44, 216],
    ["setNoticeHeight", 0, 44],
  ] as const) {
    expect(await f.quick.call(method, ["session-1", height])).toEqual({ ok: true, value: undefined });
    expect(window.getBounds()).toEqual({ ...initial, y: bottom - total, height: total });
  }
  expect(window.setMinimumSize).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("notice height validates its IPC shape and finite range before ignoring stale sessions", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  await f.quick.call("setNoticeHeight", ["session-1", 60]);
  const bounds = window.getBounds();
  window.setBounds.mockClear();
  for (const args of [
    [],
    ["session-1"],
    ["session-1", 60, 0],
    [null, 60],
    ["s".repeat(257), 60],
    ...[-0.01, 172.01, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "60", null].map(
      (height) => ["session-1", height],
    ),
    ["old-session", -1],
  ]) {
    expect(await f.quick.call("setNoticeHeight", args)).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
  }
  for (const [sessionId, height] of [
    ["session-1", 60.1],
    ["old-session", 0],
    ["old-session", 172],
  ]) {
    expect(await f.quick.call("setNoticeHeight", [sessionId, height])).toEqual({
      ok: true,
      value: undefined,
    });
  }
  expect(window.getBounds()).toEqual(bounds);
  expect(window.setBounds).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("session changes clear notice space and stale calls cannot reopen or close the current notice", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  const bottom = window.getBounds().y + window.getBounds().height;
  await f.quick.call("setComposerHeight", ["session-1", 184]);
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  f.changeSession("fresh");
  expect(window.getBounds().height).toBe(44);
  expect(window.getBounds().y + 44).toBe(bottom);
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  expect(window.getBounds().height).toBe(44);
  await f.quick.call("setNoticeHeight", ["fresh", 84]);
  const bounds = window.getBounds();
  expect(bounds.height).toBe(128);
  window.setBounds.mockClear();
  await f.quick.call("setNoticeHeight", ["session-1", 0]);
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  expect(window.getBounds()).toEqual(bounds);
  expect(window.setBounds).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("expansion clears notice space and expanded calls cannot affect bounds or a later compact window", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  await f.quick.call("setComposerHeight", ["session-1", 140]);
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  expect(window.getBounds().height).toBe(312);
  f.emitHistory(true);
  const expanded = window.getBounds();
  expect(expanded).toMatchObject({ width: 660, height: 560 });
  window.setBounds.mockClear();
  for (const height of [0, 172])
    expect(await f.quick.call("setNoticeHeight", ["session-1", height])).toEqual({
      ok: true,
      value: undefined,
    });
  expect(await f.quick.call("setNoticeHeight", ["session-1", 173])).toMatchObject({ ok: false });
  expect(window.getBounds()).toEqual(expanded);
  expect(window.setBounds).not.toHaveBeenCalled();
  f.emitHistory(false);
  expect(window.getBounds().height).toBe(140);
  await f.quick.dispose();
});

test("notice plus composer height clamps to the work area without losing the composer's own height", async () => {
  const f = fixture();
  f.getDisplay.mockReturnValue({
    bounds: { x: -320, y: -100, width: 320, height: 300 },
    workArea: { x: -320, y: -100, width: 320, height: 300 },
  });
  await f.quick.show();
  const window = f.windows[0];
  await f.quick.call("setComposerHeight", ["session-1", 140]);
  const composer = window.getBounds();
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  expect(window.getBounds()).toEqual({ x: -320, y: -100, width: 320, height: 300 });
  await f.quick.call("setNoticeHeight", ["session-1", 0]);
  expect(window.getBounds()).toEqual(composer);
  await f.quick.dispose();
});

test("renderer reload clears only notice space and stale renderer events cannot clear replacement space", async () => {
  const f = fixture();
  await f.quick.show();
  const old = f.windows[0];
  await f.quick.call("setComposerHeight", ["session-1", 92]);
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  for (const navigation of [
    { isMainFrame: false, isSameDocument: false, url: old.webContents.getURL() },
    { isMainFrame: true, isSameDocument: true, url: old.webContents.getURL() },
    { isMainFrame: true, isSameDocument: false, url: "https://blocked.invalid/" },
  ]) {
    old.webContents.emit("did-start-navigation", navigation);
    expect(old.getBounds().height).toBe(264);
  }
  old.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: old.webContents.getURL(),
  });
  expect(old.getBounds().height).toBe(92);
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  old.webContents.emit("render-process-gone");
  await f.quick.show();
  const replacement = f.windows[1];
  expect(replacement.getBounds().height).toBe(92);
  await f.quick.call("setNoticeHeight", ["session-1", 72]);
  old.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: old.webContents.getURL(),
  });
  old.emit("closed");
  expect(replacement.getBounds().height).toBe(164);
  await f.quick.dispose();
});

test("window recreation clears notice space even before the destroyed window sends its closed event", async () => {
  const f = fixture();
  await f.quick.show();
  const old = f.windows[0];
  await f.quick.call("setNoticeHeight", ["session-1", 172]);
  old.isDestroyed = () => true;
  await f.quick.show();
  const replacement = f.windows[1];
  expect(f.configs[1]).toMatchObject({ height: 44, minHeight: 44 });
  await f.quick.call("setNoticeHeight", ["session-1", 84]);
  old.emit("closed");
  expect(replacement.getBounds().height).toBe(128);
  await f.quick.dispose();
});

test("resetting an already compact multiline draft shrinks the native window immediately", async () => {
  const f = fixture();
  await f.quick.show();
  await f.quick.call("setComposerHeight", ["session-1", 184]);
  const bottom = f.windows[0].getBounds().y + 184;
  f.changeSession("fresh");
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(f.windows[0].getBounds().y + 44).toBe(bottom);
  await f.quick.dispose();
});

test("a lost new-session acknowledgement times out safely and the next invocation recreates the renderer", async () => {
  vi.useFakeTimers();
  try {
    const f = fixture({ history: true });
    await f.quick.show();
    f.quick.hide();
    f.changeSession("fresh");
    const opening = f.quick.show();
    const failed = expect(opening).rejects.toThrow("快速对话页面未准备就绪，请重试");
    await vi.advanceTimersByTimeAsync(5000);
    await failed;
    expect(f.windows[0].destroy).toHaveBeenCalledOnce();
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    await f.quick.toggle();
    expect(f.windows).toHaveLength(2);
    expect(f.windows[1].show).toHaveBeenCalledOnce();
    expect(f.windows[1].getBounds().height).toBe(44);
    expect(f.host.reset).not.toHaveBeenCalled();
    await f.quick.dispose();
  } finally {
    vi.useRealTimers();
  }
});

test.each(["restore", "bounds"])(
  "blur during native %s is reconciled after focus, just like show",
  async (operation) => {
    const f = fixture({ history: true });
    await f.quick.prepare();
    const window = f.windows[0];
    if (operation === "restore") {
      window.isMinimized.mockReturnValue(true);
      window.restore.mockImplementation(() => {
        window.emit("blur");
      });
    } else {
      f.getDisplay.mockReturnValue({
        bounds: { x: 1440, y: 0, width: 1440, height: 900 },
        workArea: { x: 1440, y: 25, width: 1440, height: 825 },
      });
      const nativeBounds = window.setBounds.getMockImplementation();
      window.setBounds.mockImplementation((bounds) => {
        nativeBounds?.(bounds);
        window.emit("blur");
      });
    }
    await f.quick.toggle();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(window.hide).not.toHaveBeenCalled();
    await f.quick.toggle();
    expect(window.hide).toHaveBeenCalledOnce();
    await f.quick.dispose();
  },
);

test("optional timings follow only the current numeric token and record post-frame hiding without user data", async () => {
  const traces: { id: number; mark: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }[] = [];
  const timing = {
    start: vi.fn((kind: string) => {
      if (kind === "event") return;
      const trace = { id: traces.length + 1, mark: vi.fn(), finish: vi.fn() };
      traces.push(trace);
      return trace;
    }),
    flush: vi.fn(async () => {}),
  };
  const f = fixture({ history: true, timing: timing as unknown as QuickChatTiming });
  await f.quick.prepare();
  expect(traces[0].finish).toHaveBeenCalledWith("ready");
  await f.quick.show();
  expect(f.windows[0].webContents.send).toHaveBeenCalledWith("zpi:quick-chat-presentation", 2);
  await f.quick.call("reportPresentation", [1, "renderer-frame"]);
  expect(traces[1].finish).not.toHaveBeenCalled();
  for (const args of [
    [2, "private text"],
    [Number.NaN, "renderer-focus"],
    ["2", "renderer-ready"],
  ])
    expect(await f.quick.call("reportPresentation", args)).toMatchObject({ ok: false });
  await f.quick.call("reportPresentation", [2, "renderer-ready"]);
  await f.quick.call("reportPresentation", [2, "renderer-focus"]);
  await f.quick.call("reportPresentation", [2, "renderer-frame"]);
  expect(traces[1].finish).toHaveBeenCalledExactlyOnceWith("shown");
  for (const [index, event] of ["blur", "hide"].entries()) {
    f.windows[0].emit(event);
    expect(traces[index + 2].mark).toHaveBeenCalledWith(
      `${event}-ignored`,
      expect.objectContaining({
        visible: true,
        focused: true,
        expanded: true,
      }),
    );
    expect(traces[index + 2].finish).toHaveBeenCalledWith("shown");
  }
  f.windows[0].blur();
  expect(traces[4].mark).toHaveBeenCalledWith(
    "blur-unfocused",
    expect.objectContaining({
      visible: true,
      focused: false,
      expanded: true,
    }),
  );
  expect(traces[4].finish).toHaveBeenCalledWith("hidden");
  await f.quick.show();
  const latest = traces[traces.length - 1];
  await f.quick.call("reportPresentation", [2, "renderer-frame"]);
  expect(latest.finish).not.toHaveBeenCalled();
  f.quick.hide();
  expect(latest.finish).toHaveBeenCalledWith("hidden");
  expect(f.host.send).not.toHaveBeenCalled();
  await f.quick.dispose();
  expect(timing.flush).toHaveBeenCalledOnce();
});

test("diagnostics distinguish explicit new, reset cleanup and renderer frame wait", async () => {
  const trace = { id: 1, mark: vi.fn(), finish: vi.fn() };
  const timing = {
    start: vi.fn((kind: string) => (kind === "event" ? undefined : trace)),
    flush: vi.fn(async () => {}),
  };
  const f = fixture({ timing: timing as unknown as QuickChatTiming });
  await f.quick.prepare();
  trace.mark.mockClear();
  let complete!: () => void;
  f.host.reset.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        complete = () => {
          f.changeSession("new");
          resolve();
        };
      }),
  );
  const opening = f.quick.newConversation();
  expect(timing.start).toHaveBeenLastCalledWith("new", "warm");
  expect(trace.mark.mock.calls.map(([stage]) => stage)).toEqual([
    "open-request",
    "reset-start",
    "reset-dispatched",
  ]);
  complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(trace.mark.mock.calls.map(([stage]) => stage)).toEqual([
    "open-request",
    "reset-start",
    "reset-dispatched",
    "reset-ready",
    "expiry-ready",
    "window-ready",
    "session-frame-wait",
  ]);
  expect(f.windows[0].show).not.toHaveBeenCalled();
  await f.rendererReady("new");
  await opening;
  expect(trace.mark.mock.calls.map(([stage]) => stage).slice(7)).toEqual([
    "session-frame-ready",
    "geometry",
    "native-show",
    "show",
    "native-focus",
    "focus",
  ]);
  await f.quick.dispose();
});

test("background discovered models also refresh the retained quick-chat snapshot", () => {
  const source = fs.readFileSync(new URL("../src/main/index.ts", import.meta.url), "utf8");
  const discovery = source.slice(
    source.indexOf("for (const id of discovered)"),
    source.indexOf("const rendererUrl"),
  );
  expect(discovery).toMatch(/await settingsReady;\s*quickChatHost.refreshSettings\(\)/);
});

test("toggle recreates a destroyed window even if its closed notification is delayed", async () => {
  const f = fixture();
  await f.quick.show();
  f.quick.hide();
  const old = f.windows[0];
  old.isDestroyed = () => true;
  old.isVisible.mockImplementation(() => {
    throw new Error("Object has been destroyed");
  });
  old.isFocused.mockImplementation(() => {
    throw new Error("Object has been destroyed");
  });
  await f.quick.toggle();
  expect(f.windows).toHaveLength(2);
  expect(f.windows[1].show).toHaveBeenCalledOnce();
  old.emit("closed");
  await f.quick.toggle();
  expect(f.windows[1].hide).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("minimum-size reuse preserves initial clamping, update order, and unchanged native-call caching", async () => {
  const f = fixture();
  f.getDisplay.mockReturnValue({
    bounds: { x: 0, y: 0, width: 320, height: 80 },
    workArea: { x: 0, y: 0, width: 320, height: 80 },
  });
  await f.quick.show();
  const window = f.windows[0];
  expect(f.configs[0]).toMatchObject({ minWidth: 320, minHeight: 44 });
  expect(window.setMinimumSize).not.toHaveBeenCalled();
  f.emitHistory(true);
  expect(window.setMinimumSize).toHaveBeenCalledExactlyOnceWith(320, 80);
  expect(window.setMinimumSize.mock.invocationCallOrder[0]).toBeLessThan(
    window.setBounds.mock.invocationCallOrder[0],
  );
  f.emitHistory(true);
  expect(window.setMinimumSize).toHaveBeenCalledOnce();
  f.emitHistory(false);
  expect(window.setMinimumSize).toHaveBeenLastCalledWith(320, 44);
  expect(window.setMinimumSize.mock.invocationCallOrder[1]).toBeLessThan(
    window.setBounds.mock.invocationCallOrder[1],
  );
  await f.quick.call("setComposerHeight", ["session-1", 184]);
  expect(window.getBounds().height).toBe(80);
  expect(window.setMinimumSize).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("explicit new keeps expanded presentation in pushes, snapshots and recreated renderers", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.host.reset.mockImplementationOnce(async () => f.changeSession("explicit-new"));
  expect(await f.quick.call("reset", [])).toMatchObject({ ok: true });
  expect(f.windows[0].getBounds().height).toBe(560);
  expect(f.windows[0].webContents.send).toHaveBeenLastCalledWith(
    "zpi:quick-chat-snapshot",
    expect.objectContaining({
      expanded: true,
      session: expect.objectContaining({ sessionId: "explicit-new", runs: [] }),
    }),
  );
  expect(await f.quick.call("getSnapshot", [])).toMatchObject({ ok: true, value: { expanded: true } });
  f.emitHistory(false);
  expect(f.windows[0].getBounds().height).toBe(560);
  f.windows[0].webContents.emit("render-process-gone");
  await f.quick.show();
  expect(f.windows[1].getBounds().height).toBe(560);
  // Expiry is a separate reset policy; only the explicit action preserves expanded mode.
  f.changeSession("expired-new");
  expect(f.windows[1].getBounds().height).toBe(44);
  expect(await f.quick.call("getSnapshot", [])).toMatchObject({ ok: true, value: { expanded: false } });
  await f.quick.dispose();
});

test.each([false, true])(
  "new-conversation shortcut from a hidden window always opens compact, previous history=%s",
  async (history) => {
    const f = fixture({ history });
    await f.quick.show();
    f.quick.hide();
    f.host.reset.mockImplementationOnce(async () => f.changeSession("shortcut-new"));
    const opening = f.quick.toggle(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    expect(f.windows[0].getBounds().height).toBe(44);
    await f.rendererReady("session-1");
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    await f.rendererReady("shortcut-new");
    await opening;
    expect(f.windows[0].show).toHaveBeenCalledTimes(2);
    expect(f.host.resetIfExpired).toHaveBeenCalledTimes(1); // Initial show only, never another reset during explicit new.
    await f.quick.dispose();
  },
);

test("new shortcut hides a confirmed blank session and ordinary resume cannot restore old history", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.host.reset.mockImplementationOnce(async () => f.changeSession("shortcut-new"));
  const fresh = f.quick.toggle(true);
  await tick();
  expect(f.host.sessionId).toBe("shortcut-new");
  expect(f.windows[0].getBounds().height).toBe(560);
  expect(f.windows[0].isVisible()).toBe(true);
  await f.rendererReady();
  await fresh;
  await hideEmptyShortcut(f);
  expect(f.windows[0].isVisible()).toBe(false);
  const resume = f.quick.toggle();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await tick();
  await f.rendererReady();
  await resume;
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(f.host.sessionId).toBe("shortcut-new");
  expect(f.host.reset).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test.each(
  ["load", "reset", "frame"].flatMap((stage) =>
    [false, true].flatMap((history) => [2, 3, 4, 8].map((presses) => ({ stage, history, presses }))),
  ),
)(
  "new shortcut keeps opening through $presses presses during $stage, history=$history",
  async ({ stage, history, presses }) => {
    const f = fixture({ autoLoad: stage !== "load", history });
    let finish = () => {};
    f.host.reset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.changeSession("pending-new");
            resolve();
          };
          if (stage !== "reset") finish();
        }),
    );
    const calls = [f.quick.toggle(true)];
    if (stage === "frame") await tick();
    for (let index = 1; index < presses; index++) calls.push(f.quick.toggle(true));
    if (stage === "reset") finish();
    if (stage === "load") f.windows[0].webContents.emit("did-finish-load");
    await f.rendererReady("session-1", 0);
    await f.rendererReady();
    await Promise.all(calls);
    const window = f.windows[0];
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.isVisible()).toBe(true);
    expect(window.getBounds().height).toBe(44);
    expect(f.host.reset).toHaveBeenCalledOnce();
    expect(window.hide).not.toHaveBeenCalled();
    expect(f.host.discardDraftAttachments).not.toHaveBeenCalled();
    // Only a confirmed empty press after the replacement frame hides it.
    await hideEmptyShortcut(f);
    expect(window.isVisible()).toBe(false);
    expect(f.host.reset).toHaveBeenCalledOnce();
    await f.quick.dispose();
  },
);

test("rapid new shortcuts share one reset and reject the old session acknowledgement", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  let finish!: () => void;
  const resetting = new Promise<void>((resolve) => {
    finish = () => {
      f.changeSession("latest-new");
      resolve();
    };
  });
  f.host.reset.mockReturnValue(resetting);
  const calls = [f.quick.toggle(true), f.quick.toggle(true), f.quick.toggle(true)];
  finish();
  await tick();
  await f.rendererReady("session-1");
  await f.rendererReady("latest-new", 0);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady();
  await Promise.all(calls);
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(f.host.reset).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test.each(["load", "frame"] as const)(
  "coalesced new %s failure reports once and the next shortcut can retry",
  async (stage) => {
    const f = fixture({ autoLoad: stage !== "load" });
    let session = 0;
    f.host.reset.mockImplementation(async () => f.changeSession(`retry-new-${++session}`));
    vi.useFakeTimers();
    try {
      const reportError = vi.fn();
      const calls = Array.from({ length: 8 }, () => f.quick.toggle(true).catch(reportError));
      if (stage === "load") {
        f.windows[0].webContents.emit("did-fail-load", {}, -2, "load failed", "", true);
      } else await vi.advanceTimersByTimeAsync(5000);
      await Promise.all(calls);
      expect(reportError).toHaveBeenCalledOnce();
      expect(f.windows[0].show).not.toHaveBeenCalled();
      expect(f.windows[0].destroy).toHaveBeenCalledOnce();
      const retry = f.quick.toggle(true);
      const repeated = f.quick.toggle(true);
      if (stage === "load") f.windows[1].webContents.emit("did-finish-load");
      await vi.advanceTimersByTimeAsync(0);
      await f.rendererReady("retry-new-1");
      expect(f.windows[1].show).not.toHaveBeenCalled();
      await f.rendererReady();
      await Promise.all([retry, repeated]);
      expect(f.windows[1].show).toHaveBeenCalledOnce();
      expect(f.host.reset).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
      await f.quick.dispose();
    }
  },
);

test.each(["hide", "space", "close", "ordinary-toggle"] as const)(
  "new after %s while reset is pending survives old completion and repeated shortcuts",
  async (action) => {
    const f = fixture({ platform: "darwin", history: true });
    let finish!: () => void;
    const resetting = new Promise<void>((resolve) => {
      finish = () => {
        f.changeSession("shared-reset");
        resolve();
      };
    });
    // QuickChatHost.reset shares one reset until its active run has stopped.
    f.host.reset.mockReturnValue(resetting);
    const old = f.quick.toggle(true);
    if (action === "space") f.spaceChanged();
    else if (action === "close") f.windows[0].emit("close", { preventDefault: vi.fn() });
    else if (action === "ordinary-toggle") await f.quick.toggle();
    else f.quick.hide();
    const current = f.quick.toggle(true);
    const repeated = f.quick.toggle(true);
    finish();
    await old; // Its finally must not erase the newer pending presentation.
    await tick();
    const afterOldCompletion = f.quick.toggle(true);
    await f.rendererReady("session-1", 0);
    expect(f.windows[0].show).not.toHaveBeenCalled();
    await f.rendererReady();
    await Promise.all([current, repeated, afterOldCompletion]);
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    expect(f.windows[0].isFocused()).toBe(true);
    expect(f.windows[0].getBounds().height).toBe(44);
    expect(f.host.reset).toHaveBeenCalledTimes(2);
    await f.quick.dispose();
  },
);

test.each(["space", "close", "dispose"] as const)(
  "%s still cancels a coalesced new presentation and ignores late readiness",
  async (action) => {
    const f = fixture({ platform: "darwin" });
    let finish!: () => void;
    f.host.reset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.changeSession("cancelled-new");
            resolve();
          };
        }),
    );
    const calls = [f.quick.toggle(true), f.quick.toggle(true), f.quick.toggle(true)];
    if (action === "space") f.spaceChanged();
    else if (action === "close") f.windows[0].emit("close", { preventDefault: vi.fn() });
    else await f.quick.dispose();
    finish();
    await f.rendererReady();
    await Promise.all(calls);
    expect(f.windows[0].show).not.toHaveBeenCalled();
    expect(f.host.reset).toHaveBeenCalledOnce();
    if (action === "dispose") {
      await f.quick.toggle(true);
      expect(f.windows).toHaveLength(1);
      expect(f.host.reset).toHaveBeenCalledOnce();
    } else {
      f.host.reset.mockImplementationOnce(async () => f.changeSession("reopened-new"));
      const reopened = f.quick.toggle(true);
      await tick();
      await f.rendererReady("cancelled-new");
      expect(f.windows[0].show).not.toHaveBeenCalled();
      await f.rendererReady();
      await reopened;
      expect(f.windows[0].show).toHaveBeenCalledOnce();
    }
    await f.quick.dispose();
  },
);

test("new shortcut replaces a pending ordinary resume instead of keeping its old history", async () => {
  const f = fixture({ autoLoad: false, history: true });
  const resume = f.quick.toggle();
  f.host.reset.mockImplementationOnce(async () => f.changeSession("fresh-instead"));
  const fresh = f.quick.toggle(true);
  const repeated = f.quick.toggle(true);
  f.windows[0].webContents.emit("did-finish-load");
  await tick();
  await f.rendererReady("session-1", 0);
  expect(f.windows[0].show).not.toHaveBeenCalled();
  await f.rendererReady();
  await Promise.all([resume, fresh, repeated]);
  expect(f.host.sessionId).toBe("fresh-instead");
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  expect(f.host.reset).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("new shortcut replaces a pending composer probe and ignores its stale occupied reply", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const resume = f.quick.toggle();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  f.host.reset.mockImplementationOnce(async () => f.changeSession("fresh-after-probe"));
  const fresh = f.quick.toggle(true);
  const repeated = f.quick.toggle(true);
  await resume;
  await f.quick.call("reportComposerState", [token, sessionId, true]);
  await f.rendererReady(sessionId);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady();
  await Promise.all([fresh, repeated]);
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(f.host.reset).toHaveBeenCalledTimes(2); // Initial expanded new plus this fresh shortcut.
  await f.quick.dispose();
});

test.each(["explicit", "plus"] as const)(
  "new shortcut joins a visible %s reset and its frame wait instead of hiding old pixels",
  async (source) => {
    const f = fixture({ history: true });
    await f.quick.show();
    let finish!: () => void;
    f.host.reset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.changeSession("visible-new");
            resolve();
          };
        }),
    );
    const explicit = source === "plus" ? f.quick.call("reset", []) : f.quick.newConversation();
    const repeated = Array.from({ length: 8 }, () => f.quick.toggle(true));
    expect(f.windows[0].isVisible()).toBe(true);
    finish();
    await tick();
    repeated.push(f.quick.toggle(true));
    await f.rendererReady("session-1", 0);
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    await f.rendererReady();
    await Promise.all([explicit, ...repeated]);
    expect(f.windows[0].show).toHaveBeenCalledTimes(2);
    expect(f.host.reset).toHaveBeenCalledOnce();
    await hideEmptyShortcut(f);
    expect(f.windows[0].isVisible()).toBe(false);
    await f.quick.dispose();
  },
);

test("new shortcut still focuses through show-time blur and a real blur allows a fresh reopen", async () => {
  const f = fixture({ platform: "darwin", history: true });
  await f.quick.prepare();
  const window = f.windows[0];
  const nativeShow = window.show.getMockImplementation();
  window.show.mockImplementation(() => {
    nativeShow?.();
    window.emit("blur");
  });
  let session = 0;
  f.host.reset.mockImplementation(async () => f.changeSession(`focus-new-${++session}`));
  for (let index = 0; index < 3; index++) {
    const opening = f.quick.toggle(true);
    const repeated = f.quick.toggle(true);
    await tick();
    await f.rendererReady();
    await Promise.all([opening, repeated]);
    expect(window.isVisible()).toBe(true);
    expect(window.isFocused()).toBe(true);
    expect(window.show).toHaveBeenCalledTimes(index + 1);
    window.emit("blur"); // Queued blur while native focus is retained is ignored.
    expect(window.isVisible()).toBe(true);
    window.blur();
    expect(window.isVisible()).toBe(false);
  }
  expect(f.host.reset).toHaveBeenCalledTimes(3);
  await f.quick.dispose();
});

test("hidden automation mode coalesces pending new then toggles logical presentation without native focus", async () => {
  const f = fixture({ hidden: true });
  let session = 0;
  f.host.reset.mockImplementation(async () => f.changeSession(`hidden-${++session}`));
  const first = f.quick.toggle(true);
  const repeated = f.quick.toggle(true);
  await tick();
  await f.rendererReady();
  await Promise.all([first, repeated]);
  await hideEmptyShortcut(f);
  expect(f.host.reset).toHaveBeenCalledOnce();
  const reopened = f.quick.toggle(true);
  await tick();
  await f.rendererReady();
  await reopened;
  expect(f.host.reset).toHaveBeenCalledTimes(2);
  expect(f.windows[0].show).not.toHaveBeenCalled();
  expect(f.windows[0].focus).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("new shortcut brings forward an unfocused native panel using the ordinary toggle decision", async () => {
  const f = fixture({ history: true, platform: "darwin" });
  await f.quick.show();
  const window = f.windows[0];
  window.isFocused.mockReturnValue(false);
  f.getDisplay.mockReturnValue({
    bounds: { x: 1440, y: 0, width: 1000, height: 700 },
    workArea: { x: 1440, y: 0, width: 1000, height: 700 },
  });
  f.host.reset.mockImplementationOnce(async () => f.changeSession("unfocused-new"));
  const opening = f.quick.toggle(true);
  await tick();
  await f.rendererReady();
  await opening;
  expect(window.show).toHaveBeenCalledTimes(2);
  expect(window.hide).not.toHaveBeenCalled();
  expect(window.getBounds()).toMatchObject({ width: 660, height: 560 });
  expect(window.getBounds().x).toBeGreaterThanOrEqual(1440);
  window.isFocused.mockReturnValue(true);
  await hideEmptyShortcut(f);
  expect(window.hide).toHaveBeenCalledOnce();
  expect(f.host.reset).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("new shortcut joins a pending expiry without hiding or starting another reset", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  let finish!: () => void;
  f.host.resetIfExpired.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          f.changeSession("expired-new");
          resolve();
        };
      }),
  );
  const opening = f.quick.toggle();
  const fresh = f.quick.toggle(true);
  finish();
  await f.rendererReady();
  await Promise.all([opening, fresh]);
  expect(f.host.reset).not.toHaveBeenCalled();
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.windows[0].getBounds().height).toBe(44);
  await f.quick.dispose();
});

test("explicit new remains unconditional when already visible, and cold new remains compact", async () => {
  const f = fixture();
  f.host.reset.mockImplementationOnce(async () => f.changeSession("cold-new"));
  const cold = f.quick.newConversation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.rendererReady("cold-new");
  await cold;
  expect(f.windows[0].getBounds().height).toBe(44);
  f.emitHistory(true);
  f.host.reset.mockImplementationOnce(async () => f.changeSession("visible-new"));
  const next = f.quick.newConversation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.rendererReady("visible-new");
  await next;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.windows[0].hide).not.toHaveBeenCalled();
  expect(f.windows[0].getBounds().height).toBe(560);
  await f.quick.dispose();
});

test("repeated explicit new while resetting uses the newest visibility intent without stale acknowledgement", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  let complete!: () => void;
  const reset = new Promise<void>((resolve) => {
    complete = () => {
      f.changeSession("shared-new");
      resolve();
    };
  });
  f.host.reset.mockImplementation(() => reset);
  const first = f.quick.newConversation();
  const second = f.quick.newConversation();
  await f.quick.toggle();
  complete();
  await Promise.all([first, second]);
  await f.rendererReady("session-1");
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  expect(f.windows[0].getBounds().height).toBe(44);
  const reopened = f.quick.toggle();
  await f.rendererReady("shared-new");
  await reopened;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("explicit new during a pending hidden expiry preserves the compact invocation intent", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  let complete!: () => void;
  const reset = new Promise<void>((resolve) => {
    complete = () => {
      f.changeSession("shared-new");
      resolve();
    };
  });
  f.host.resetIfExpired.mockReturnValueOnce(reset);
  f.host.reset.mockReturnValueOnce(reset);
  const expired = f.quick.toggle();
  const explicit = f.quick.newConversation();
  complete();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.rendererReady("shared-new");
  await Promise.all([expired, explicit]);
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("image attachment IPC accepts bytes and owned identifiers, never paths or data URLs", async () => {
  const f = fixture();
  const bytes = new Uint8Array([137, 80, 78, 71]);
  expect(await f.quick.call("importAttachment", ["session-1", "paste.png", bytes])).toMatchObject({
    ok: true,
    value: { id: "image-1" },
  });
  expect(f.host.importAttachment).toHaveBeenCalledWith("session-1", "paste.png", bytes);
  expect(await f.quick.call("readAttachment", ["session-1", "image-1"])).toMatchObject({
    ok: true,
    value: { data: "image-bytes" },
  });
  expect(await f.quick.call("removeAttachment", ["session-1", "image-1"])).toMatchObject({ ok: true });
  expect(await f.quick.call("send", ["", ["image-1"]])).toMatchObject({ ok: true });
  expect(f.host.send).toHaveBeenCalledWith("", ["image-1"]);
  f.host.importAttachment.mockClear();
  for (const args of [
    ["session-1", "paste.png", "data:image/png;base64,AAAA"],
    ["session-1", "paste.png", "/tmp/image.png"],
    ["session-1", "paste.png", [137, 80]],
    ["session-1", "paste.png"],
    ["session-1", "x".repeat(251), bytes],
  ]) {
    expect(await f.quick.call("importAttachment", args)).toMatchObject({ ok: false });
  }
  expect(f.host.importAttachment).not.toHaveBeenCalled();
  f.host.send.mockImplementation(() => {
    throw new Error("invalid_input: 图片附件无效");
  });
  expect(await f.quick.call("send", ["", ["unknown-image"]])).toMatchObject({
    ok: false,
    error: { code: "invalid_input" },
  });
  await f.quick.dispose();
});

test("image draft height grows upward to 240 and still clamps to the native work area", async () => {
  const f = fixture();
  await f.quick.show();
  const window = f.windows[0];
  const bottom = window.getBounds().y + window.getBounds().height;
  await f.quick.call("setComposerHeight", ["session-1", 240]);
  expect(window.getBounds().height).toBe(240);
  expect(window.getBounds().y + 240).toBe(bottom);
  f.getDisplay.mockReturnValue({
    bounds: { x: 0, y: 0, width: 320, height: 80 },
    workArea: { x: 0, y: 0, width: 320, height: 80 },
  });
  await f.quick.call("setComposerHeight", ["session-1", 239]);
  expect(window.getBounds()).toEqual({ x: 0, y: 0, width: 320, height: 80 });
  await f.quick.dispose();
});

test("renderer reload and destruction release draft images, never ordinary hide or stale windows", async () => {
  const f = fixture();
  await f.quick.show();
  const old = f.windows[0];
  f.quick.hide();
  await f.quick.show();
  old.webContents.emit("did-start-navigation", {
    isMainFrame: false,
    isSameDocument: false,
    url: old.webContents.getURL(),
  });
  old.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: true,
    url: old.webContents.getURL(),
  });
  old.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: "https://blocked.invalid/",
  });
  expect(f.host.discardDraftAttachments).not.toHaveBeenCalled();
  old.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: old.webContents.getURL(),
  });
  expect(f.host.discardDraftAttachments).toHaveBeenCalledOnce();
  old.webContents.emit("render-process-gone");
  expect(f.host.discardDraftAttachments).toHaveBeenCalledTimes(2);
  await f.quick.show();
  old.webContents.emit("did-start-navigation", {
    isMainFrame: true,
    isSameDocument: false,
    url: old.webContents.getURL(),
  });
  old.emit("closed");
  expect(f.host.discardDraftAttachments).toHaveBeenCalledTimes(2);
  expect(f.host.reset).not.toHaveBeenCalled();
  await f.quick.dispose();
});

test("visible expanded new captures its mode before a later hide and never reopens from a late reset", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  let finish!: () => void;
  f.host.reset.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          f.changeSession("visible-intent");
          resolve();
        };
      }),
  );
  const opening = f.quick.newConversation();
  f.quick.hide();
  finish();
  await opening;
  expect(f.windows[0].getBounds().height).toBe(560);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady("visible-intent");
  await f.quick.toggle();
  expect(f.windows[0].getBounds().height).toBe(560);
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("hidden new remains compact even if a normal show presents the old session during reset", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  let finish!: () => void;
  f.host.reset.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          f.changeSession("hidden-intent");
          resolve();
        };
      }),
  );
  const opening = f.quick.newConversation();
  await f.quick.show();
  expect(f.windows[0].isVisible()).toBe(true);
  finish();
  await opening;
  expect(f.windows[0].getBounds().height).toBe(44);
  expect(await f.quick.call("getSnapshot", [])).toMatchObject({ ok: true, value: { expanded: false } });
  await f.quick.dispose();
});

test("the latest hidden new intent wins when two explicit actions share one pending reset", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  let finish!: () => void;
  const resetting = new Promise<void>((resolve) => {
    finish = () => {
      f.changeSession("latest-hidden");
      resolve();
    };
  });
  f.host.reset.mockReturnValue(resetting);
  const visibleNew = f.quick.newConversation();
  f.quick.hide();
  const hiddenNew = f.quick.newConversation();
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.rendererReady("session-1");
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady("latest-hidden");
  await Promise.all([visibleNew, hiddenNew]);
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.windows[0].getBounds().height).toBe(44);
  await f.quick.dispose();
});

test.each(["blur", "space"])(
  "new after %s hiding resets compact while ordinary toggle still restores history",
  async (reason) => {
    const f = fixture({ history: true, platform: "darwin" });
    await f.quick.show();
    if (reason === "space") f.spaceChanged();
    else f.windows[0].blur();
    await f.quick.toggle();
    expect(f.windows[0].getBounds().height).toBe(560);
    expect(f.host.reset).not.toHaveBeenCalled();
    if (reason === "space") f.spaceChanged();
    else f.windows[0].blur();
    f.host.reset.mockImplementationOnce(async () => f.changeSession("hidden-new"));
    const opening = f.quick.newConversation();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.rendererReady("hidden-new");
    await opening;
    expect(f.windows[0].getBounds().height).toBe(44);
    await f.quick.dispose();
  },
);

test("visible expanded new does not require focus, and destroyed retained windows are never queried for visibility", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.windows[0].isFocused.mockReturnValue(false);
  f.host.reset.mockImplementationOnce(async () => f.changeSession("visible-unfocused"));
  await f.quick.call("reset", []);
  expect(f.windows[0].getBounds().height).toBe(560);
  const old = f.windows[0];
  old.isDestroyed = () => true;
  old.isVisible.mockImplementation(() => {
    throw new Error("Object has been destroyed");
  });
  f.host.reset.mockImplementationOnce(async () => f.changeSession("after-destroy"));
  const opening = f.quick.newConversation();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.rendererReady("after-destroy");
  await opening;
  expect(f.windows[1].getBounds().height).toBe(44);
  await f.quick.dispose();
});

test("desired visibility in hidden test mode is not native visibility for a new conversation", async () => {
  const f = fixture({ history: true, hidden: true });
  await f.quick.show();
  expect(f.windows[0].getBounds().height).toBe(560);
  expect(f.windows[0].isVisible()).toBe(false);
  f.host.reset.mockImplementationOnce(async () => f.changeSession("never-presented"));
  await f.quick.call("reset", []);
  expect(f.windows[0].getBounds().height).toBe(44);
  await f.quick.dispose();
});

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

test.each(["blur", "hide"] as const)(
  "a queued native %s from hide cannot cancel a hidden new preparation",
  async (event) => {
    const f = fixture({ platform: "darwin" });
    await f.quick.show();
    f.quick.hide();
    let finish!: () => void;
    f.host.reset.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = () => {
            f.changeSession("queued-native-new");
            resolve();
          };
        }),
    );
    const opening = f.quick.toggle(true);
    f.windows[0].emit(event);
    const joined = f.quick.toggle(true);
    finish();
    await tick();
    f.windows[0].emit(event);
    await f.rendererReady();
    await Promise.all([opening, joined]);
    expect(f.host.reset).toHaveBeenCalledOnce();
    expect(f.windows[0].isVisible()).toBe(true);
    expect(f.windows[0].isFocused()).toBe(true);
    await f.quick.dispose();
  },
);
const latestSnapshot = (f: ReturnType<typeof fixture>) =>
  f.windows
    .at(-1)
    ?.webContents.send.mock.calls.filter(([channel]) => channel === "zpi:quick-chat-snapshot")
    .at(-1)?.[1] as QuickChatSnapshot;
const latestProbe = (f: ReturnType<typeof fixture>) =>
  f.windows
    .at(-1)
    ?.webContents.send.mock.calls.filter(([channel]) => channel === "zpi:quick-chat-composer")
    .at(-1) as [string, number, string];
async function emptyExpanded() {
  const f = fixture({ history: true, platform: "darwin" });
  await f.quick.show();
  f.host.reset.mockImplementationOnce(async () => f.changeSession("empty-new"));
  await f.quick.call("reset", []);
  await f.rendererReady();
  expect(latestSnapshot(f)).toMatchObject({ expanded: true, session: { runs: [] } });
  return f;
}

test("warm blank-expanded resume sends its composer request in the invocation stack", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  f.windows[0].webContents.send.mockClear();
  const opening = f.quick.toggle();
  expect(f.windows[0].webContents.send).toHaveBeenCalledWith(
    "zpi:quick-chat-composer",
    expect.any(Number),
    f.host.sessionId,
  );
  const [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await tick();
  await f.rendererReady();
  await opening;
  expect(f.windows[0].isVisible()).toBe(true);
  expect(f.windows[0].getBounds().height).toBe(44);
  await f.quick.dispose();
});

test.each(["blur", "hide"] as const)(
  "a queued native %s cannot cancel the ordinary blank-expanded resume",
  async (event) => {
    const f = await emptyExpanded();
    f.quick.hide();
    const opening = f.quick.toggle();
    await tick();
    f.windows[0].emit(event);
    const [, token, sessionId] = latestProbe(f);
    await f.quick.call("reportComposerState", [token, sessionId, false]);
    await tick();
    f.windows[0].emit(event);
    await f.rendererReady();
    await opening;
    expect(f.windows[0].isVisible()).toBe(true);
    expect(f.windows[0].isFocused()).toBe(true);
    expect(f.windows[0].getBounds().height).toBe(44);
    await f.quick.dispose();
  },
);

test.each([
  [false, false, false, false],
  [false, false, true, false],
  [false, false, undefined, false],
  [true, false, false, false],
  [true, false, true, true],
  [true, false, undefined, true],
  [false, true, false, true],
  [false, true, true, true],
  [false, true, undefined, true],
  [true, true, false, true],
  [true, true, true, true],
  [true, true, undefined, true],
] as const)(
  "resume presentation matrix expanded=%s history=%s occupied=%s → %s",
  (expanded, history, occupied, expected) => {
    expect(resumeQuickChatExpanded(expanded, history, occupied)).toBe(expected);
  },
);

test("visible new stays expanded once, but empty hidden resume folds only after a matching compact frame", async () => {
  const f = await emptyExpanded();
  const old = latestSnapshot(f);
  const window = f.windows[0];
  expect(window.getBounds().height).toBe(560);
  await f.quick.toggle();
  const opening = f.quick.toggle();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await tick();
  const compact = latestSnapshot(f);
  expect(compact).toMatchObject({ expanded: false, session: { sessionId, runs: [] } });
  expect(compact.revision).toBeGreaterThan(old.revision);
  expect(compact.presentationVersion).toBeGreaterThan(old.presentationVersion as number);
  expect(window.getBounds().height).toBe(44);
  expect(window.show).toHaveBeenCalledOnce();
  await f.rendererReady(sessionId, old.presentationVersion);
  expect(window.show).toHaveBeenCalledOnce();
  await f.rendererReady();
  await opening;
  expect(window.show).toHaveBeenCalledTimes(2);
  window.webContents.send.mockClear();
  for (let index = 0; index < 3; index++) {
    await f.quick.toggle();
    await f.quick.toggle();
    expect(window.getBounds().height).toBe(44);
  }
  expect(window.webContents.send.mock.calls.some(([channel]) => channel === "zpi:quick-chat-composer")).toBe(
    false,
  );
  expect(f.host.reset).toHaveBeenCalledOnce();
  await f.quick.dispose();
});

test("occupied empty-history drafts keep expanded; clearing them retires the new-chat allowance", async () => {
  const f = await emptyExpanded();
  for (const occupied of [true, true, false]) {
    f.quick.hide();
    const opening = f.quick.show();
    await tick();
    const [, token, sessionId] = latestProbe(f);
    await f.quick.call("reportComposerState", [token, sessionId, occupied]);
    await tick();
    if (!occupied) await f.rendererReady();
    await opening;
    expect(f.windows[0].getBounds().height).toBe(occupied ? 560 : 44);
  }
  await f.quick.dispose();
});

test("probe timeout preserves unknown drafts, retries on the next resume, and never destroys the renderer", async () => {
  const f = await emptyExpanded();
  vi.useFakeTimers();
  try {
    f.quick.hide();
    const opening = f.quick.show();
    await vi.advanceTimersByTimeAsync(250);
    await opening;
    expect(f.windows[0].getBounds().height).toBe(560);
    expect(f.windows[0].destroy).not.toHaveBeenCalled();
    expect(f.host.discardDraftAttachments).not.toHaveBeenCalled();
    const old = latestProbe(f);
    f.quick.hide();
    const second = f.quick.show();
    await vi.advanceTimersByTimeAsync(0);
    const next = latestProbe(f);
    expect(next[1]).not.toBe(old[1]);
    await f.quick.call("reportComposerState", [old[1], old[2], false]);
    expect(f.windows[0].getBounds().height).toBe(560);
    await f.quick.call("reportComposerState", [next[1], next[2], true]);
    await second;
  } finally {
    vi.useRealTimers();
    await f.quick.dispose();
  }
});

test.each(["toggle", "space", "dispose", "crash"] as const)(
  "%s cancels pending occupancy without stale replies reviving the window",
  async (action) => {
    const f = await emptyExpanded();
    f.quick.hide();
    const opening = f.quick.show();
    await tick();
    const [, token, sessionId] = latestProbe(f);
    if (action === "toggle") await f.quick.toggle();
    else if (action === "space") f.spaceChanged();
    else if (action === "crash") f.windows[0].webContents.emit("render-process-gone");
    else await f.quick.dispose();
    await opening;
    await f.quick.call("reportComposerState", [token, sessionId, false]);
    await f.rendererReady();
    expect(f.windows[0].show).toHaveBeenCalledOnce();
    expect(f.host.reset).toHaveBeenCalledOnce(); // Only the initial explicit new; cancellation never resets.
    await f.quick.dispose();
  },
);

test("third toggle starts a fresh probe and ignores the cancelled second-toggle reply", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const first = f.quick.toggle();
  await tick();
  const old = latestProbe(f);
  await f.quick.toggle();
  await first;
  const current = f.quick.toggle();
  await tick();
  const next = latestProbe(f);
  await f.quick.call("reportComposerState", [old[1], old[2], false]);
  expect(f.windows[0].getBounds().height).toBe(560);
  await f.quick.call("reportComposerState", [next[1], next[2], true]);
  await current;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("a host run accepted while probing wins over an empty composer reply", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const opening = f.quick.show();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  f.emitHistory(true);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await opening;
  expect(f.windows[0].getBounds().height).toBe(560);
  expect(await f.quick.call("getSnapshot", [])).toMatchObject({ value: { expanded: true } });
  await f.quick.dispose();
});

test("new session invalidates a pending probe and old version; only the current frame may show", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const opening = f.quick.show();
  await tick();
  const old = latestProbe(f);
  const oldVersion = latestSnapshot(f).presentationVersion;
  f.changeSession("expired");
  await tick();
  await f.quick.call("reportComposerState", [old[1], old[2], true]);
  await f.rendererReady("expired", oldVersion);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady();
  await opening;
  expect(f.windows[0].getBounds().height).toBe(44);
  await f.quick.dispose();
});

test("frame version changes while waiting continue with the latest projection instead of timing out", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const opening = f.quick.show();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await tick();
  const foldedVersion = latestSnapshot(f).presentationVersion;
  f.changeSession("newer-session");
  await tick();
  await f.rendererReady("newer-session", foldedVersion);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.rendererReady();
  await opening;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

test("probe and frame IPC reject malformed data and ignore foreign sessions", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const opening = f.quick.show();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  for (const args of [
    [token, sessionId, "false"],
    [Number.NaN, sessionId, false],
    [token, sessionId],
  ])
    expect(await f.quick.call("reportComposerState", args)).toMatchObject({ ok: false });
  for (const args of [[sessionId], [sessionId, -1], [sessionId, Number.NaN], [sessionId, "1"]])
    expect(await f.quick.call("rendererReady", args)).toMatchObject({ ok: false });
  await f.quick.call("reportComposerState", [token, "other", false]);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.quick.call("reportComposerState", [token, sessionId, true]);
  await opening;
  await f.quick.dispose();
});

test("warm history resume does not clone snapshots or probe the renderer", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  f.quick.hide();
  f.host.getSnapshot.mockClear();
  f.windows[0].webContents.send.mockClear();
  const opening = f.quick.show();
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  expect(f.host.getSnapshot).not.toHaveBeenCalled();
  expect(f.windows[0].webContents.send).not.toHaveBeenCalled();
  await opening;
  await f.quick.dispose();
});

test("hide intent retires blank expansion even if native visibility has not caught up", async () => {
  const f = await emptyExpanded();
  const window = f.windows[0];
  window.hide.mockImplementationOnce(() => {});
  f.quick.hide();
  expect(window.isVisible()).toBe(true);
  const opening = f.quick.show();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await tick();
  await f.rendererReady();
  await opening;
  expect(window.getBounds().height).toBe(44);
  await f.quick.dispose();
});

test("explicit reset cancels a pending probe before an old run finishes stopping", async () => {
  const f = await emptyExpanded();
  f.quick.hide();
  const opening = f.quick.show();
  await tick();
  const [, token, sessionId] = latestProbe(f);
  let finish!: () => void;
  f.host.reset.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = () => {
          f.changeSession("explicit-latest");
          resolve();
        };
      }),
  );
  const reset = f.quick.call("reset", []);
  await opening;
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  finish();
  await reset;
  expect(latestSnapshot(f)).toMatchObject({ expanded: false, session: { sessionId: "explicit-latest" } });
  const latest = f.quick.show();
  await f.rendererReady();
  await latest;
  expect(f.windows[0].show).toHaveBeenCalledTimes(2);
  await f.quick.dispose();
});

async function hideEmptyShortcut(f: ReturnType<typeof fixture>) {
  const hiding = f.quick.toggle(true);
  const [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, false]);
  await hiding;
}

test.each(
  [false, true].flatMap((expanded) => [false, true, undefined].map((occupied) => ({ expanded, occupied }))),
)(
  "visible new classifies composer occupied=$occupied expanded=$expanded and coalesces the probe",
  async ({ expanded, occupied }) => {
    const f = expanded ? await emptyExpanded() : fixture();
    if (!expanded) await f.quick.show();
    const window = f.windows[0];
    const resets = f.host.reset.mock.calls.length;
    f.host.reset.mockImplementationOnce(async () => f.changeSession("replaced-draft"));
    const calls = Array.from({ length: 8 }, () => f.quick.toggle(true));
    const probes = window.webContents.send.mock.calls.filter(
      ([channel]) => channel === "zpi:quick-chat-composer",
    );
    expect(probes).toHaveLength(1);
    const [, token, sessionId] = latestProbe(f);
    expect(window.isVisible()).toBe(true);
    expect(f.host.reset).toHaveBeenCalledTimes(resets);
    if (occupied === undefined) await new Promise((resolve) => setTimeout(resolve, 275));
    else await f.quick.call("reportComposerState", [token, sessionId, occupied]);
    if (occupied !== false) {
      await tick();
      expect(f.host.sessionId).toBe("replaced-draft");
      expect(window.isVisible()).toBe(true);
      expect(window.getBounds().height).toBe(expanded ? 560 : 44);
      await f.quick.call("reportComposerState", [token, sessionId, false]);
      await f.rendererReady(sessionId, 0);
      await f.rendererReady();
    }
    await Promise.all(calls);
    expect(f.host.reset).toHaveBeenCalledTimes(resets + (occupied === false ? 0 : 1));
    expect(window.isVisible()).toBe(occupied !== false);
    await f.quick.dispose();
  },
);

test.each(["hide", "ordinary-toggle", "space", "close", "crash", "dispose", "session", "show"] as const)(
  "%s cancels a visible new probe so its old occupied reply cannot reset or hide the latest state",
  async (action) => {
    const f = await emptyExpanded();
    const window = f.windows[0];
    const fresh = f.quick.toggle(true);
    const [, token, sessionId] = latestProbe(f);
    if (action === "hide") f.quick.hide();
    else if (action === "ordinary-toggle") await f.quick.toggle();
    else if (action === "space") f.spaceChanged();
    else if (action === "close") window.emit("close", { preventDefault: vi.fn() });
    else if (action === "crash") window.webContents.emit("render-process-gone");
    else if (action === "dispose") await f.quick.dispose();
    else if (action === "session") f.changeSession("external-new");
    else await f.quick.show();
    await f.quick.call("reportComposerState", [token, sessionId, true]);
    await fresh;
    expect(f.host.reset).toHaveBeenCalledOnce(); // Only the setup's explicit new.
    expect(!window.isDestroyed() && window.isVisible()).toBe(action === "session" || action === "show");
    if (action !== "dispose") await f.quick.dispose();
  },
);

test.each(["run", "reload"] as const)(
  "%s invalidates an empty probe response and completes the current explicit new intent",
  async (change) => {
    const f = fixture();
    await f.quick.show();
    f.host.reset.mockImplementationOnce(async () => f.changeSession("after-change"));
    const fresh = f.quick.toggle(true);
    const [, token, sessionId] = latestProbe(f);
    if (change === "run") f.emitHistory(true);
    else
      f.windows[0].webContents.emit("did-start-navigation", {
        isMainFrame: true,
        isSameDocument: false,
        url: f.windows[0].webContents.getURL(),
      });
    await f.quick.call("reportComposerState", [token, sessionId, false]);
    await tick();
    await f.rendererReady();
    await fresh;
    expect(f.host.reset).toHaveBeenCalledOnce();
    expect(f.host.sessionId).toBe("after-change");
    expect(f.windows[0].isVisible()).toBe(true);
    await f.quick.dispose();
  },
);

test("a failed visible new releases the shared intent and a later shortcut can reset successfully", async () => {
  const f = fixture();
  await f.quick.show();
  f.host.reset.mockRejectedValueOnce(new Error("busy: stop failed"));
  const report = vi.fn();
  const attempts = Array.from({ length: 8 }, () => f.quick.toggle(true).catch(report));
  let [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, true]);
  await Promise.all(attempts);
  expect(report).toHaveBeenCalledOnce();
  expect(f.windows[0].isVisible()).toBe(true);
  f.host.reset.mockImplementationOnce(async () => f.changeSession("retry-new"));
  const retry = f.quick.toggle(true);
  [, token, sessionId] = latestProbe(f);
  await f.quick.call("reportComposerState", [token, sessionId, true]);
  await tick();
  await f.rendererReady();
  await retry;
  expect(f.host.reset).toHaveBeenCalledTimes(2);
  expect(f.host.sessionId).toBe("retry-new");
  await f.quick.dispose();
});

test("global new joining a failed + reset leaves failure reporting with the + operation and can retry", async () => {
  const f = fixture({ history: true });
  await f.quick.show();
  let reject!: (reason: unknown) => void;
  f.host.reset.mockImplementationOnce(
    () =>
      new Promise<void>((_, fail) => {
        reject = fail;
      }),
  );
  const plus = f.quick.call("reset", []);
  const report = vi.fn();
  const joins = Array.from({ length: 8 }, () => f.quick.toggle(true).catch(report));
  reject(new Error("busy: stop failed"));
  expect(await plus).toMatchObject({ ok: false });
  await Promise.all(joins);
  expect(report).not.toHaveBeenCalled();
  expect(f.onError).toHaveBeenCalledOnce();
  f.host.reset.mockImplementationOnce(async () => f.changeSession("retry-plus"));
  const retry = f.quick.toggle(true);
  await tick();
  await f.rendererReady();
  await retry;
  expect(f.host.reset).toHaveBeenCalledTimes(2);
  expect(f.windows[0].isVisible()).toBe(true);
  await f.quick.dispose();
});
