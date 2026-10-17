import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, test, vi } from "vitest";
import type { QuickChatHost } from "../src/main/quick-chat-host.ts";
import { installQuickChatIpc, QuickChatWindow } from "../src/main/quick-chat-window.ts";
import type { QuickChatSnapshot } from "../src/shared/quick-chat.ts";

function fixture(
  options: { autoLoad?: boolean; hidden?: boolean; platform?: NodeJS.Platform; history?: boolean } = {},
) {
  let snapshot = { revision: 1, session: { runs: options.history ? [{}] : [] } } as QuickChatSnapshot;
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
    resetIfExpired: vi.fn(async () => {}),
    readWebSourceIcon: vi.fn(async () => undefined as string | undefined),
  };
  const windows: ReturnType<typeof makeWindow>[] = [];
  const configs: BrowserWindowConstructorOptions[] = [];
  const copyText = vi.fn();
  const openExternal = vi.fn(async () => {});
  function makeWindow(config: BrowserWindowConstructorOptions) {
    let bounds = { x: config.x ?? 0, y: config.y ?? 0, width: config.width ?? 0, height: config.height ?? 0 };
    let focused = false;
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
      isMinimized: () => false,
      getBounds: () => ({ ...bounds }),
      setBounds: vi.fn((next) => {
        bounds = { ...next };
      }),
      setMinimumSize: vi.fn(),
      isFocused: vi.fn(() => focused),
      show: vi.fn(),
      focus: vi.fn(() => {
        focused = true;
      }),
      restore: vi.fn(),
      hide: vi.fn(() => {
        focused = false;
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
    emitHistory: (history: boolean) => {
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        session: { runs: history ? [{}] : [] },
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
  window.emit("blur");
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
