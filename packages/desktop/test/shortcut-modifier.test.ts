import { EventEmitter } from "node:events";
import type { Input, WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import { ShortcutModifier } from "../src/main/shortcut-modifier.ts";

// Electron before-input-event shape, not a DOM KeyboardEvent.
function input(overrides: Partial<Input> = {}): Input {
  return {
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
    modifiers: ["meta", "left"],
    ...overrides,
  };
}
function setup(platform = "darwin") {
  const send = vi.fn(),
    enabled = vi.fn(() => true);
  const modifier = new ShortcutModifier(platform, enabled, send);
  const host = new EventEmitter(),
    guest = new EventEmitter();
  modifier.observe(host as WebContents, true);
  modifier.observe(guest as WebContents);
  const emit = (event: Input, content = host) => {
    const native = { preventDefault: vi.fn() };
    content.emit("before-input-event", native, event);
    expect(native.preventDefault).not.toHaveBeenCalled();
  };
  return { modifier, host, guest, send, enabled, emit };
}
describe("native shortcut modifier hints", () => {
  it.each(["MetaLeft", "MetaRight"])("shows on %s alone and hides on release despite stale flags", (code) => {
    const f = setup();
    f.emit(input({ code, meta: false, modifiers: [] }));
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", code, meta: true }));
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
  it("keeps hints when the other Command key remains held", () => {
    const f = setup();
    f.emit(input());
    f.emit(input({ code: "MetaRight", location: 2 }));
    f.emit(input({ type: "keyUp" }));
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", code: "MetaRight", meta: false, modifiers: [] }));
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
  it("shares host and guest transitions, observes handled chords and does not dispatch commands", () => {
    const f = setup();
    f.emit(input(), f.guest);
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ key: "1", code: "Digit1" }), f.guest);
    f.emit(input({ key: "1", code: "Digit1", type: "keyUp" }), f.guest);
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", meta: false, modifiers: [] }));
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
  it.each(["did-start-loading", "render-process-gone", "destroyed"])("clears on %s", (event) => {
    const f = setup();
    f.emit(input(), f.guest);
    f.guest.emit(event);
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
  it.each(["blur", "did-start-loading", "render-process-gone", "destroyed"])(
    "ignores background guest %s",
    (event) => {
      const f = setup();
      f.emit(input());
      f.guest.emit(event);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
      f.emit(input({ type: "keyUp" }));
      expect(f.send).toHaveBeenLastCalledWith(false);
    },
  );
  it("retains both Command keys across internal host/guest focus changes", () => {
    const f = setup();
    f.emit(input());
    f.emit(input({ code: "MetaRight" }));
    f.host.emit("blur");
    expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
    f.emit(input({ type: "keyUp" }), f.guest);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
    f.emit(input({ type: "keyUp", code: "MetaRight" }), f.guest);
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
  it.each(["did-start-loading", "render-process-gone"])(
    "resets the consumer on host %s even when a guest owns the held modifier",
    (event) => {
      const f = setup();
      f.emit(input(), f.guest);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
      f.host.emit(event);
      expect(f.send).toHaveBeenLastCalledWith(false);
      // The replacement consumer must receive the next held state, not lose it to deduplication.
      f.send.mockClear();
      f.emit(input({ key: "1", code: "Digit1" }), f.guest);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
      f.emit(input({ type: "keyUp" }), f.guest);
      expect(f.send).toHaveBeenLastCalledWith(false);
    },
  );
  it("sends only state changes while typing or repeating keys", () => {
    const f = setup();
    f.emit(input({ key: "a", code: "KeyA", meta: false }));
    expect(f.send).not.toHaveBeenCalled();
    f.emit(input());
    f.emit(input({ isAutoRepeat: true }));
    f.emit(input({ key: "1", code: "Digit1" }));
    f.emit(input({ key: "1", code: "Digit1", type: "keyUp" }));
    expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
    f.emit(input({ type: "keyUp" }));
    expect(f.send.mock.calls).toEqual([[true], [false]]);
  });
  it("ignores disabled/recording input and cleans listeners on disposal", () => {
    const f = setup();
    f.emit(input());
    f.enabled.mockReturnValue(false);
    f.modifier.reset();
    f.emit(input());
    expect(f.send).toHaveBeenLastCalledWith(false);
    f.modifier.dispose();
    f.send.mockClear();
    f.emit(input());
    f.emit(input(), f.guest);
    f.host.emit("blur");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["linux", "win32"])("tracks only Control on %s", (platform) => {
    const f = setup(platform);
    f.emit(input());
    expect(f.send).not.toHaveBeenCalled();
    f.emit(input({ key: "Control", code: "ControlLeft", meta: false, control: false }));
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", key: "Control", code: "ControlLeft", control: true }));
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
});
