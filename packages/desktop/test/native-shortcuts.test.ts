import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PaneServices } from "../src/main/pane-services.ts";
import { ShortcutModifier } from "../src/main/shortcut-modifier.ts";

const fake = vi.hoisted(() => ({ contents: [] as EventEmitter[] }));
vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }),
  },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      close: vi.fn(),
      getURL: () => "",
      getTitle: () => "",
      isLoading: () => false,
      navigationHistory: { getActiveIndex: () => 0, getAllEntries: () => [] },
    });
    setBounds = vi.fn();
    constructor() {
      fake.contents.push(this.webContents);
    }
  },
}));

describe("native browser keyboard boundary", () => {
  it("forwards only keydown events as DOM-like input and consumes handled shortcuts", () => {
    const shortcut = vi.fn(() => true);
    const services = new PaneServices({} as never, vi.fn(), shortcut);
    services.createBrowser("");
    const content = fake.contents.at(-1);
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
    const services = new PaneServices({} as never, vi.fn(), shortcut);
    services.createBrowser("");
    const event = { preventDefault: vi.fn() };
    const content = fake.contents.at(-1);
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
  function setup() {
    const window = {
      isDestroyed: () => false,
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getContentBounds: () => ({ width: 800, height: 600 }),
      webContents: { getZoomFactor: () => 1 },
    };
    const services = new PaneServices(window as never, vi.fn());
    const { id } = services.createBrowser("");
    const content = fake.contents.at(-1) as EventEmitter & {
      isFocused: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn>;
    };
    const show = () => services.bounds(id, { x: 300, y: 0, width: 500, height: 600 });
    return { services, id, content, show };
  }

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
    if (mode === "hidden") f.services.bounds(f.id, null);
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
    const window = {
      contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
      getContentBounds: () => ({ width: 800, height: 600 }),
      webContents: { getZoomFactor: () => 1 },
    };
    const services = new PaneServices(window as never, vi.fn(), shortcut, modifier);
    const { id } = services.createBrowser("");
    services.bounds(id, { x: 0, y: 0, width: 500, height: 600 });
    const content = fake.contents.at(-1);
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
    services.bounds(id, null);
    expect(send).toHaveBeenLastCalledWith(false);
    modifier.dispose();
  });
});
