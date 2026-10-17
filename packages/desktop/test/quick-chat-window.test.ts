import { EventEmitter } from "node:events";
import fs from "node:fs";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, test, vi } from "vitest";
import type { QuickChatHost } from "../src/main/quick-chat-host.ts";
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
    openExternal,
    loadSourceIcon: vi.fn(async () => undefined),
  });
  return {
    quick,
    host,
    windows,
    configs,
    copyText,
    openExternal,
    getDisplay,
    workspaceNotifications,
    spaceChanged: () => spaceChanged(),
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
    },
  };
}

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

test("macOS uses a nonactivating unparented panel and visible-but-unfocused toggle brings it forward", async () => {
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
  window.show.mockImplementationOnce(() => f.spaceChanged());
  await f.quick.show();
  expect(window.focus).not.toHaveBeenCalled();
  await f.quick.toggle();
  expect(window.focus).toHaveBeenCalledOnce();
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
  expect(f.host.send).toHaveBeenCalledWith("hello");
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
  await f.quick.call("rendererReady", ["session-1"]);
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
  await f.quick.call("rendererReady", ["session-1"]);
  expect(f.windows[0].show).toHaveBeenCalledOnce();
  await f.quick.call("rendererReady", ["new-session"]);
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
  await f.quick.call("rendererReady", ["new-session"]);
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
    await f.quick.call("rendererReady", ["replacement"]);
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
  for (const height of [0, 43, 185, Number.NaN, Number.POSITIVE_INFINITY, "100"]) {
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
    start: vi.fn(() => {
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
    expect(traces[index + 2].mark).toHaveBeenCalledWith(`${event}-ignored`, {
      visible: true,
      focused: true,
      expanded: true,
    });
    expect(traces[index + 2].finish).toHaveBeenCalledWith("shown");
  }
  f.windows[0].blur();
  expect(traces[4].mark).toHaveBeenCalledWith("blur-unfocused", {
    visible: true,
    focused: false,
    expanded: true,
  });
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
