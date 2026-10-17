import { EventEmitter } from "node:events";
import type { BrowserWindow, BrowserWindowConstructorOptions, IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, test, vi } from "vitest";
import type { QuickChatHost } from "../src/main/quick-chat-host.ts";
import { installQuickChatIpc, QuickChatWindow } from "../src/main/quick-chat-window.ts";

function fixture(options: { autoLoad?: boolean; hidden?: boolean } = {}) {
  const host = {
    subscribe: vi.fn(() => vi.fn()),
    refreshSettings: vi.fn(),
    close: vi.fn(async () => {}),
    getSnapshot: vi.fn(() => ({ revision: 1 })),
    send: vi.fn(),
    stop: vi.fn(async () => {}),
    reset: vi.fn(async () => {}),
    setSelection: vi.fn(),
  };
  const windows: ReturnType<typeof makeWindow>[] = [];
  const configs: BrowserWindowConstructorOptions[] = [];
  const copyText = vi.fn();
  const openExternal = vi.fn(async () => {});
  function makeWindow() {
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
      show: vi.fn(),
      focus: vi.fn(),
      restore: vi.fn(),
      hide: vi.fn(() => {
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
      const window = makeWindow();
      windows.push(window);
      return window as unknown as BrowserWindow;
    },
    rendererUrl: "file:///app/renderer/index.html",
    preload: "/app/preload/quick-chat.cjs",
    hiddenTestMode: options.hidden ?? false,
    copyText,
    openExternal,
  });
  return { quick, host, windows, configs, copyText, openExternal };
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
    alwaysOnTop: true,
    webPreferences: {
      preload: "/app/preload/quick-chat.cjs",
      partition: "zpi-quick-chat",
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
    },
  });
  expect(window.loadURL).toHaveBeenCalledWith("file:///app/renderer/index.html?view=quick-chat");
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
    "file:///app/renderer/index.html?view=quick-chat",
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
