import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { PaneServices } from "../src/main/pane-services.ts";

const fake = vi.hoisted(() => ({ contents: [] as EventEmitter[] }));
vi.mock("electron", () => ({
  session: {
    fromPartition: () => ({ setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn() }),
  },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      isDestroyed: () => false,
      getURL: () => "",
      getTitle: () => "",
      isLoading: () => false,
      navigationHistory: { getActiveIndex: () => 0, getAllEntries: () => [] },
    });
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
