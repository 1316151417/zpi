import { describe, expect, it, vi } from "vitest";
import {
  forwardBrowserShortcut,
  ShortcutController,
  toggleShortcutWindow,
} from "../src/main/shortcut-controller.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

function fixture(testMode = false) {
  const callbacks = new Map<string, () => void>();
  const registry = {
    register: vi.fn((key: string, callback: () => void) => {
      callbacks.set(key, callback);
      return true;
    }),
    unregister: vi.fn((key: string) => {
      callbacks.delete(key);
    }),
  };
  const execute = vi.fn();
  const ignoreMenuShortcuts = vi.fn();
  const controller = new ShortcutController(registry, "darwin", execute, testMode, ignoreMenuShortcuts);
  const settings = defaultShortcuts("darwin");
  controller.initialize(settings);
  return {
    callbacks,
    registry,
    execute,
    controller,
    settings,
    ignoreMenuShortcuts,
    original: settings.bindings["toggle-window"] ?? "",
  };
}
describe("global shortcut transaction", () => {
  it("registers the new binding before persistence and releases the old only after success", () => {
    const { controller, settings, registry, callbacks, execute, original } = fixture();
    const next = "Control+Command+T";
    settings.bindings["toggle-window"] = next;
    controller.update(settings, () => {
      expect([...callbacks.keys()]).toEqual([original, next]);
      expect(registry.unregister).not.toHaveBeenCalled();
      callbacks.get(next)?.();
      expect(execute).not.toHaveBeenCalled();
      return undefined;
    });
    expect([...callbacks.keys()]).toEqual([next]);
    callbacks.get(next)?.();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it.each(["false", "throws"])("keeps the old shortcut and never persists if registration %s", (failure) => {
    const { controller, settings, registry, callbacks, execute, original } = fixture();
    registry.register.mockImplementationOnce(() => {
      if (failure === "throws") throw Error("rejected");
      return false;
    });
    settings.bindings["toggle-window"] = "Control+Command+T";
    const persist = vi.fn(() => undefined);
    expect(() => controller.update(settings, persist)).toThrow("全局快捷键注册失败");
    expect(persist).not.toHaveBeenCalled();
    expect([...callbacks.keys()]).toEqual([original]);
    callbacks.get(original)?.();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("rolls back the replacement registration when persistence fails", () => {
    const { controller, settings, registry, callbacks, execute, original } = fixture();
    const next = "Control+Command+T";
    settings.bindings["toggle-window"] = next;
    expect(() =>
      controller.update(settings, () => {
        throw Error("disk full");
      }),
    ).toThrow("disk full");
    expect(registry.unregister).toHaveBeenCalledExactlyOnceWith(next);
    expect([...callbacks.keys()]).toEqual([original]);
    callbacks.get(original)?.();
    expect(execute).toHaveBeenCalledTimes(1);
  });
  it("preserves registration when disabling fails, then releases it after successful disable", () => {
    const { controller, settings, callbacks, original } = fixture();
    settings.enabled = false;
    expect(() =>
      controller.update(settings, () => {
        throw Error("disk full");
      }),
    ).toThrow("disk full");
    expect(callbacks.has(original)).toBe(true);
    controller.update(settings, () => undefined);
    expect(callbacks.size).toBe(0);
    settings.enabled = true;
    controller.update(settings, () => undefined);
    expect(callbacks.has(original)).toBe(true);
  });
  it("does not re-register unchanged binding and suspends callbacks during recording", () => {
    const { controller, settings, callbacks, registry, execute, original } = fixture();
    controller.update(settings, () => undefined);
    expect(registry.register).toHaveBeenCalledTimes(1);
    const originalCallback = callbacks.get(original);
    controller.setCapture(true);
    expect(callbacks.has(original)).toBe(false);
    originalCallback?.();
    expect(execute).not.toHaveBeenCalled();
    controller.setCapture(false);
    expect(callbacks.has(original)).toBe(true);
    expect(registry.register).toHaveBeenCalledTimes(2);
    originalCallback?.();
    expect(execute).not.toHaveBeenCalled();
    callbacks.get(original)?.();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(() => controller.setCapture("true" as unknown as boolean)).toThrow("录制状态无效");
    expect(() => controller.update({ ...settings, enabled: "no" } as never, () => undefined)).toThrow(
      "invalid_input",
    );
  });
  it("reports failed capture restoration and can retry without altering stored settings", () => {
    const { controller, callbacks, registry, settings, execute, original } = fixture();
    controller.setCapture(true);
    registry.register.mockReturnValueOnce(false);
    expect(() => controller.setCapture(false)).toThrow("全局快捷键注册失败");
    expect(controller.isCapturing).toBe(false);
    expect(callbacks.has(original)).toBe(false);
    expect(execute).not.toHaveBeenCalled();
    controller.update(settings, () => undefined);
    expect(callbacks.has(original)).toBe(true);
  });
  it("rejects settings writes during capture and does not re-register after disposing a recording", () => {
    const { controller, registry, settings } = fixture();
    controller.setCapture(true);
    expect(() => controller.update(settings, () => undefined)).toThrow("请先结束快捷键录制");
    controller.dispose();
    controller.setCapture(false);
    expect(registry.register).toHaveBeenCalledTimes(1);
    expect(registry.unregister).toHaveBeenCalledTimes(1);
  });
  it("restores native menu shortcuts on finish, reload/reset failure and disposal", () => {
    const { controller, registry, ignoreMenuShortcuts } = fixture();
    controller.setCapture(true);
    expect(ignoreMenuShortcuts).toHaveBeenLastCalledWith(true);
    controller.setCapture(false);
    expect(ignoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    controller.setCapture(true);
    registry.register.mockReturnValueOnce(false);
    expect(() => controller.setCapture(false)).toThrow("全局快捷键注册失败");
    expect(ignoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    controller.setCapture(true);
    controller.dispose();
    expect(ignoreMenuShortcuts).toHaveBeenLastCalledWith(false);
    expect(controller.isCapturing).toBe(false);
  });
  it("cleans up only its own shortcut and ignores stale callbacks after disposal", () => {
    const { controller, callbacks, registry, execute, original } = fixture();
    const callback = callbacks.get(original);
    controller.dispose();
    controller.dispose();
    callback?.();
    expect(execute).not.toHaveBeenCalled();
    expect(registry.unregister).toHaveBeenCalledExactlyOnceWith(original);
  });
  it("never registers system shortcuts in test mode", () => {
    const { controller, settings, registry } = fixture(true);
    settings.bindings["toggle-window"] = "Control+Command+T";
    controller.update(settings, () => undefined);
    controller.dispose();
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });
});
describe("window shortcut", () => {
  function window(visible = true, focused = true, minimized = false, destroyed = false) {
    return {
      isVisible: () => visible,
      isFocused: () => focused,
      isMinimized: () => minimized,
      isDestroyed: () => destroyed,
      hide: vi.fn(() => {
        visible = false;
        focused = false;
      }),
      show: vi.fn(() => {
        visible = true;
      }),
      restore: vi.fn(() => {
        minimized = false;
      }),
      focus: vi.fn(() => {
        focused = true;
      }),
      destroy: () => {
        destroyed = true;
      },
    };
  }
  it("hides the foreground window", () => {
    const target = window();
    expect(toggleShortcutWindow(target)).toBe(false);
    expect(target.hide).toHaveBeenCalledOnce();
    expect(target.show).not.toHaveBeenCalled();
  });
  it.each([
    [false, false, false],
    [true, false, false],
    [true, true, true],
  ])("shows and focuses hidden/background/minimized windows: %s, %s, %s", (visible, focused, minimized) => {
    const target = window(visible, focused, minimized);
    expect(toggleShortcutWindow(target)).toBe(true);
    expect(target.show).toHaveBeenCalledOnce();
    expect(target.focus).toHaveBeenCalledOnce();
    expect(target.restore).toHaveBeenCalledTimes(minimized ? 1 : 0);
    expect(target.hide).not.toHaveBeenCalled();
  });
  it.each(["show", "restore", "focus"] as const)(
    "does not report a successful show when destroyed during %s",
    (phase) => {
      const target = window(false, false, phase === "restore");
      target[phase].mockImplementationOnce(() => target.destroy());
      expect(toggleShortcutWindow(target)).toBe(false);
    },
  );
  it("requires a visible focused window before allowing a lost-target fallback", () => {
    const target = window(false, false);
    target.focus.mockImplementationOnce(() => {});
    expect(toggleShortcutWindow(target)).toBe(false);
  });
  it("ignores a destroyed window", () => {
    const target = window(true, true, false, true);
    expect(toggleShortcutWindow(target)).toBe(false);
    expect(target.hide).not.toHaveBeenCalled();
    expect(target.show).not.toHaveBeenCalled();
  });
});

describe("native browser workspace command dispatch", () => {
  it.each(["darwin", "linux"])("hands focus back to the host once before dispatch on %s", (platform) => {
    const order: string[] = [];
    const focusHost = vi.fn(() => order.push("host"));
    const send = vi.fn((command: string) => order.push(command));
    const event = { key: "i", metaKey: platform === "darwin", ctrlKey: platform !== "darwin" };
    const settings = defaultShortcuts(platform);
    expect(forwardBrowserShortcut(event, platform, settings, send, focusHost)).toBe(true);
    expect(order).toEqual(["host", "focus-composer"]);
    expect(forwardBrowserShortcut({ ...event, repeat: true }, platform, settings, send, focusHost)).toBe(
      true,
    );
    expect(focusHost).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not steal guest focus for other commands or intercept its disabled/unbound/IME input", () => {
    const focusHost = vi.fn(),
      send = vi.fn();
    const settings = defaultShortcuts("darwin");
    expect(forwardBrowserShortcut({ key: "j", metaKey: true }, "darwin", settings, send, focusHost)).toBe(
      true,
    );
    expect(send).toHaveBeenCalledExactlyOnceWith("toggle-sidebar");
    expect(focusHost).not.toHaveBeenCalled();
    send.mockClear();
    for (const event of [
      { key: "i", metaKey: true, isComposing: true },
      { key: "i", metaKey: true, altKey: true },
    ])
      expect(forwardBrowserShortcut(event, "darwin", settings, send, focusHost)).toBe(false);
    settings.bindings["focus-composer"] = null;
    expect(forwardBrowserShortcut({ key: "i", metaKey: true }, "darwin", settings, send, focusHost)).toBe(
      false,
    );
    settings.enabled = false;
    expect(forwardBrowserShortcut({ key: "j", metaKey: true }, "darwin", settings, send, focusHost)).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
    expect(focusHost).not.toHaveBeenCalled();
  });
});
