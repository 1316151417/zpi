import { EventEmitter } from "node:events";
import type { Input, InputEvent, WebContents } from "electron";
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
  const emit = (event: Input | InputEvent, content = host, channel = "before-input-event") => {
    const native = { preventDefault: vi.fn() };
    content.emit(channel, native, event);
    expect(native.preventDefault).not.toHaveBeenCalled();
  };
  return { modifier, host, guest, send, enabled, emit };
}
describe("native shortcut modifier hints", () => {
  it("tracks Command alone and release when Chromium bypasses before-input-event", () => {
    const f = setup();
    f.emit({ ...input(), type: "rawKeyDown" }, f.host, "input-event");
    expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
    f.emit(input({ key: "1", code: "Digit1" }));
    f.emit(input({ type: "keyUp", meta: false }), f.host, "input-event");
    expect(f.send.mock.calls).toEqual([[true], [false]]);
  });
  it("deduplicates both event paths while retaining the other Command key", () => {
    const f = setup();
    for (const code of ["MetaLeft", "MetaRight"]) {
      f.emit(input({ code }));
      f.emit({ ...input({ code }), type: "rawKeyDown" }, f.host, "input-event");
    }
    for (const code of ["MetaLeft", "MetaRight"]) {
      const meta = code === "MetaLeft";
      f.emit(input({ code, type: "keyUp", meta }), f.guest);
      f.emit(input({ code, type: "keyUp", meta }), f.guest, "input-event");
    }
    expect(f.send.mock.calls).toEqual([[true], [false]]);
  });
  it("reads modifier snapshots without keyboard fields and ignores mouse/character events", () => {
    const f = setup();
    f.emit({ type: "rawKeyDown", modifiers: ["meta"] }, f.guest, "input-event");
    for (const type of ["mouseMove", "char"] as const) {
      f.emit({ type, modifiers: [] }, f.guest, "input-event");
    }
    expect(f.send).toHaveBeenCalledExactlyOnceWith(true);
    f.emit({ type: "keyUp", modifiers: [] }, f.host, "input-event");
    expect(f.send.mock.calls).toEqual([[true], [false]]);
  });
  it.each(["MetaLeft", "MetaRight"])("shows on %s alone and hides on release", (code) => {
    const f = setup();
    f.emit(input({ code }));
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", code, meta: false }));
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
  it("uses the aggregate state when a Command key was pressed outside the observed contents", () => {
    const f = setup();
    f.emit(input({ type: "keyUp", code: "MetaLeft", meta: true }));
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", code: "MetaRight", meta: false }));
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
      f.emit(input({ type: "keyUp", meta: false }));
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
    f.emit(input({ type: "keyUp", code: "MetaRight", meta: false }), f.guest);
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
      f.emit(input({ type: "keyUp", meta: false }), f.guest);
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
    f.emit(input({ type: "keyUp", meta: false }));
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
    f.emit({ ...input(), type: "rawKeyDown" }, f.host, "input-event");
    f.emit({ ...input(), type: "rawKeyDown" }, f.guest, "input-event");
    f.host.emit("blur");
    expect(f.send).not.toHaveBeenCalled();
  });
  it.each(["linux", "win32"])("tracks only Control on %s", (platform) => {
    const f = setup(platform);
    f.emit(input());
    expect(f.send).not.toHaveBeenCalled();
    f.emit(input({ key: "Control", code: "ControlLeft", meta: false, control: true }));
    expect(f.send).toHaveBeenLastCalledWith(true);
    f.emit(input({ type: "keyUp", key: "Control", code: "ControlLeft", control: false }));
    expect(f.send).toHaveBeenLastCalledWith(false);
  });
});
