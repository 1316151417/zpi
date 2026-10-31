import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PaneServices } from "../src/main/pane-services.ts";
import { ShortcutModifier } from "../src/main/shortcut-modifier.ts";

const fake = vi.hoisted(() => ({
  contents: [] as { id: number }[],
  isolated: { setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() },
}));
vi.mock("electron", () => ({
  session: { fromPartition: () => fake.isolated },
  webContents: { fromId: (id: number) => fake.contents.find((content) => content.id === id) },
}));

function guest(hostWebContents: unknown) {
  const content = Object.assign(new EventEmitter(), {
    id: fake.contents.length + 1,
    hostWebContents,
    session: fake.isolated,
    getType: (): string => "webview",
    setWindowOpenHandler: vi.fn(),
    isDestroyed: vi.fn(() => false),
    isFocused: vi.fn(() => false),
    close: vi.fn(),
    loadURL: vi.fn().mockResolvedValue(undefined),
    getURL: () => "about:blank",
    getTitle: () => "",
    isLoading: () => false,
    navigationHistory: { getActiveIndex: () => 0, getAllEntries: () => [] },
  });
  fake.contents.push(content);
  return content;
}
function setup(shortcut = vi.fn(() => false), modifier?: ShortcutModifier) {
  const window = { webContents: {} };
  const services = new PaneServices(window as never, vi.fn(), shortcut, modifier);
  const { id } = services.createBrowser("");
  const content = guest(window.webContents);
  const show = (visible = true) => services.attachBrowserGuest(id, content.id, visible);
  show();
  return { window, services, id, content, show };
}

describe("native browser keyboard boundary", () => {
  it("forwards only keydown events as DOM-like input and consumes handled shortcuts", () => {
    const shortcut = vi.fn(() => true);
    const { content } = setup(shortcut);
    const event = { preventDefault: vi.fn() };
    const input = {
      type: "keyDown",
      key: "j",
      code: "KeyJ",
      control: false,
      meta: true,
      alt: false,
      shift: false,
      isAutoRepeat: false,
      isComposing: false,
    };
    content?.emit("before-input-event", event, input);
    expect(shortcut).toHaveBeenCalledExactlyOnceWith({
      key: "j",
      code: "KeyJ",
      ctrlKey: false,
      metaKey: true,
      altKey: false,
      shiftKey: false,
      repeat: false,
      isComposing: false,
    });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    content?.emit("before-input-event", event, { ...input, type: "keyUp" });
    expect(shortcut).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });
  it("preserves unhandled native input and exposes composition/repeat state to the dispatcher", () => {
    const shortcut = vi.fn(() => false);
    const { content } = setup(shortcut);
    const event = { preventDefault: vi.fn() };
    content?.emit("before-input-event", event, {
      type: "keyDown",
      key: "Process",
      code: "KeyJ",
      control: false,
      meta: true,
      alt: false,
      shift: false,
      isAutoRepeat: true,
      isComposing: true,
    });
    expect(shortcut).toHaveBeenCalledWith(expect.objectContaining({ repeat: true, isComposing: true }));
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

describe("native browser focus retention", () => {
  it("preserves a visible live guest's existing focus without moving host or guest focus", () => {
    const f = setup();
    f.show();
    expect(f.services.hasFocusedBrowser()).toBe(false);
    f.content.isFocused.mockReturnValue(true);
    expect(f.services.hasFocusedBrowser()).toBe(true);
    expect(f.services.hasFocusedBrowser()).toBe(true);
  });

  it.each(["hidden", "closed", "destroyed", "unfocused"])("allows fallback when the guest is %s", (mode) => {
    const f = setup();
    f.show();
    f.content.isFocused.mockReturnValue(true);
    if (mode === "hidden") f.show(false);
    if (mode === "closed") f.services.closeBrowser(f.id);
    if (mode === "destroyed") f.content.isDestroyed.mockReturnValue(true);
    if (mode === "unfocused") f.content.isFocused.mockReturnValue(false);
    expect(f.services.hasFocusedBrowser()).toBe(false);
  });
});

describe("guest modifier hint wiring", () => {
  it("observes modifier-only keyup before the command keydown filter and clears hidden guests", () => {
    const send = vi.fn();
    const modifier = new ShortcutModifier("darwin", () => true, send);
    const shortcut = vi.fn(() => false);
    const { services, id, content } = setup(shortcut, modifier);
    const event = { preventDefault: vi.fn() };
    const input = {
      type: "keyDown",
      key: "Meta",
      code: "MetaLeft",
      meta: true,
      control: false,
      alt: false,
      shift: false,
      isAutoRepeat: false,
      isComposing: false,
      location: 1,
      modifiers: [],
    };
    content?.emit("before-input-event", event, input);
    expect(send).toHaveBeenLastCalledWith(true);
    content?.emit("before-input-event", event, { ...input, type: "keyUp", meta: false });
    expect(send).toHaveBeenLastCalledWith(false);
    expect(shortcut).toHaveBeenCalledTimes(1);
    expect(event.preventDefault).not.toHaveBeenCalled();
    content?.emit("before-input-event", event, input);
    services.attachBrowserGuest(id, content.id, false);
    expect(send).toHaveBeenLastCalledWith(false);
    modifier.dispose();
  });
});

describe("browser guest ownership and lifetime", () => {
  it("hardens guests before attach and rejects unrecognized sources or partitions", () => {
    const { services } = setup();
    const preferences: Electron.WebPreferences = {
      preload: "/untrusted-preload.js",
      nodeIntegration: true,
      nodeIntegrationInSubFrames: true,
      nodeIntegrationInWorker: true,
      webviewTag: true,
      webSecurity: false,
      sandbox: false,
    };
    const params = {
      src: "about:blank",
      partition: "persist:zpi-browser",
      preload: "/untrusted-preload.js",
      nodeintegration: "true",
      nodeintegrationinsubframes: "true",
      disablewebsecurity: "true",
    };
    expect(services.prepareBrowserGuest(preferences, params)).toBe(true);
    expect(preferences).toMatchObject({
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      session: fake.isolated,
      nodeIntegration: false,
      nodeIntegrationInSubFrames: false,
      nodeIntegrationInWorker: false,
      webviewTag: false,
      allowRunningInsecureContent: false,
    });
    expect(preferences).not.toHaveProperty("preload");
    expect(params).toEqual({ src: "about:blank", partition: "persist:zpi-browser" });
    expect(services.prepareBrowserGuest({}, { ...params, src: "https://example.test/" })).toBe(false);
    expect(services.prepareBrowserGuest({}, { ...params, partition: "default" })).toBe(false);
    services.close();
    expect(services.prepareBrowserGuest({}, params)).toBe(false);
  });

  it("rejects foreign windows, non-webview contents, duplicate ownership and invalid arguments", () => {
    const f = setup();
    const foreign = guest({});
    const other = f.services.createBrowser("");
    expect(() => f.services.attachBrowserGuest(f.id, foreign.id, true)).toThrow("不属于此标签或窗口");
    expect(() => f.services.attachBrowserGuest(other.id, f.content.id, true)).toThrow("不属于此标签或窗口");
    const host = guest(f.window.webContents);
    host.getType = () => "window";
    expect(() => f.services.attachBrowserGuest(other.id, host.id, true)).toThrow("不属于此标签或窗口");
    expect(() => f.services.attachBrowserGuest(f.id, NaN, true)).toThrow("guest 无效");
    expect(() => f.services.attachBrowserGuest(f.id, f.content.id, null as never)).toThrow("guest 无效");
  });

  it("queues initial navigation until attach and never reloads on repeated attach or visibility changes", () => {
    const window = { webContents: {} };
    const emit = vi.fn();
    const services = new PaneServices(window as never, emit);
    const { id } = services.createBrowser("");
    services.action(id, "navigate", "https://example.test/");
    expect(emit).toHaveBeenLastCalledWith({
      type: "browser",
      state: expect.objectContaining({ url: "https://example.test/" }),
    });
    const content = guest(window.webContents);
    services.attachBrowserGuest(id, content.id, true);
    services.attachBrowserGuest(id, content.id, false);
    services.attachBrowserGuest(id, content.id, true);
    expect(content.loadURL).toHaveBeenCalledExactlyOnceWith("https://example.test/");
    services.closeBrowser(id);
    expect(content.close).toHaveBeenCalledOnce();
    expect(() => services.attachBrowserGuest(id, content.id, true)).toThrow("not_found");
    services.close();
    expect(() => services.createBrowser("")).toThrow("窗口已关闭");
  });
});
