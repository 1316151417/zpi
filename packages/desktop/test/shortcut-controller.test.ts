import { describe, expect, it, vi } from "vitest";
import {
  forwardBrowserShortcut,
  ShortcutController,
  setWindowMenuShortcutsIgnored,
  toggleShortcutWindow,
} from "../src/main/shortcut-controller.ts";
import { defaultShortcuts, shortcutCommands } from "../src/shared/shortcuts.ts";

function fixture(testMode = false, quickChat = false, quickChatNew = false) {
  const callbacks = new Map<string, () => void>();
  const registry = {
    register: vi.fn((key: string, callback: () => void) => {
      if (callbacks.has(key)) return false;
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
  settings.bindings["quick-chat-screenshot"] = null;
  settings.bindings["quick-chat-selection"] = null;
  settings.bindings["quick-chat-clipboard"] = null;
  if (!quickChat) settings.bindings["quick-chat"] = null;
  if (!quickChatNew) settings.bindings["quick-chat-new"] = null;
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
    const { controller, callbacks, registry, execute, original, ignoreMenuShortcuts } = fixture();
    const callback = callbacks.get(original);
    controller.dispose();
    controller.dispose();
    callback?.();
    expect(execute).not.toHaveBeenCalled();
    expect(registry.unregister).toHaveBeenCalledExactlyOnceWith(original);
    expect(ignoreMenuShortcuts).toHaveBeenCalledExactlyOnceWith(false);
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
describe("multiple global shortcut transactions", () => {
  it("dispatches the two global actions independently and respects clearing and master disable", () => {
    const { controller, callbacks, settings, execute, original } = fixture(false, true);
    callbacks.get(original)?.();
    callbacks.get("Alt+Space")?.();
    expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"]]);
    settings.bindings["quick-chat"] = null;
    controller.update(settings, () => undefined);
    expect([...callbacks.keys()]).toEqual([original]);
    settings.enabled = false;
    controller.update(settings, () => undefined);
    expect(callbacks.size).toBe(0);
  });

  it.each(["registration", "persistence"])("rolls back both replacements on %s failure", (failure) => {
    const { controller, callbacks, registry, settings, execute, original } = fixture(false, true);
    settings.bindings["toggle-window"] = "Control+Command+T";
    settings.bindings["quick-chat"] = "Control+Command+B";
    const register = registry.register.getMockImplementation();
    registry.register.mockImplementation((key, callback) =>
      failure === "registration" && key === "Control+Command+B" ? false : register?.(key, callback) === true,
    );
    const persist = vi.fn(() => {
      throw new Error("disk full");
    });
    expect(() => controller.update(settings, persist)).toThrow(
      failure === "registration" ? "全局快捷键注册失败" : "disk full",
    );
    expect(persist).toHaveBeenCalledTimes(failure === "registration" ? 0 : 1);
    expect([...callbacks.keys()]).toEqual([original, "Alt+Space"]);
    callbacks.get(original)?.();
    callbacks.get("Alt+Space")?.();
    expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"]]);
  });

  it("swaps shared accelerator ownership atomically without re-registering or unregistering them", () => {
    const { controller, callbacks, registry, settings, execute, original } = fixture(false, true);
    const other = "Control+Command+B";
    settings.bindings["quick-chat"] = other;
    controller.update(settings, () => undefined);
    registry.register.mockClear();
    registry.unregister.mockClear();
    settings.bindings["toggle-window"] = other;
    settings.bindings["quick-chat"] = original;
    expect(() =>
      controller.update(settings, () => {
        throw new Error("disk full");
      }),
    ).toThrow("disk full");
    callbacks.get(original)?.();
    callbacks.get(other)?.();
    expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"]]);
    execute.mockClear();
    controller.update(settings, () => {
      callbacks.get(original)?.();
      callbacks.get(other)?.();
      expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"]]);
      return undefined;
    });
    execute.mockClear();
    callbacks.get(original)?.();
    callbacks.get(other)?.();
    expect(execute.mock.calls).toEqual([["quick-chat"], ["toggle-window"]]);
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
  });

  it("reuses an old accelerator moved to the other command while registering a fresh one", () => {
    const { controller, callbacks, settings, execute, original } = fixture(false, true);
    const staleQuickChat = callbacks.get("Alt+Space");
    settings.bindings["toggle-window"] = "Control+Command+T";
    settings.bindings["quick-chat"] = original;
    controller.update(settings, () => {
      callbacks.get("Control+Command+T")?.();
      expect(execute).not.toHaveBeenCalled();
      return undefined;
    });
    expect([...callbacks.keys()]).toEqual([original, "Control+Command+T"]);
    staleQuickChat?.();
    expect(execute).not.toHaveBeenCalled();
    callbacks.get(original)?.();
    callbacks.get("Control+Command+T")?.();
    expect(execute.mock.calls).toEqual([["quick-chat"], ["toggle-window"]]);
  });

  it("suspends both shortcuts, keeps available capture restorations and retries missing ones safely", () => {
    const { controller, callbacks, registry, execute, original } = fixture(false, true);
    const staleCallbacks = [...callbacks.values()];
    controller.setCapture(true);
    expect(callbacks.size).toBe(0);
    for (const callback of staleCallbacks) callback();
    expect(execute).not.toHaveBeenCalled();
    const register = registry.register.getMockImplementation();
    registry.register
      .mockImplementationOnce((key, callback) => register?.(key, callback) === true)
      .mockReturnValueOnce(false);
    expect(() => controller.setCapture(false)).toThrow("全局快捷键注册失败");
    expect([...callbacks.keys()]).toEqual([original]);
    callbacks.get(original)?.();
    expect(execute).toHaveBeenCalledExactlyOnceWith("toggle-window");
    execute.mockClear();
    controller.setCapture(false);
    for (const callback of staleCallbacks) callback();
    expect(execute).not.toHaveBeenCalled();
    callbacks.get(original)?.();
    callbacks.get("Alt+Space")?.();
    expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"]]);
  });

  it.each(["toggle-window", "quick-chat", "quick-chat-new"] as const)(
    "keeps the other action available when %s is occupied at initialization",
    (blocked) => {
      const callbacks = new Map<string, () => void>();
      const settings = defaultShortcuts("darwin");
      const registry = {
        register: vi.fn((binding: string, callback: () => void) => {
          if (binding === settings.bindings[blocked]) return false;
          callbacks.set(binding, callback);
          return true;
        }),
        unregister: vi.fn((binding: string) => callbacks.delete(binding)),
      };
      const execute = vi.fn();
      const controller = new ShortcutController(registry, "darwin", execute);
      expect(() => controller.initialize(settings)).toThrow("全局快捷键注册失败");
      const available = shortcutCommands
        .filter(({ id, scope }) => scope === "global" && id !== blocked)
        .map(({ id }) => id);
      const bindings = available.map((command) => settings.bindings[command] ?? "");
      expect([...callbacks.keys()]).toEqual(bindings);
      for (const binding of bindings) callbacks.get(binding)?.();
      expect(execute.mock.calls).toEqual(available.map((command) => [command]));
      controller.dispose();
      expect(registry.unregister.mock.calls).toEqual(bindings.map((binding) => [binding]));
    },
  );

  it("disposes both owned registrations while preserving unrelated application registrations", () => {
    const { controller, callbacks, registry, execute } = fixture(false, true);
    const staleCallbacks = [...callbacks.values()];
    const other = vi.fn();
    registry.register("Control+Command+B", other);
    controller.dispose();
    controller.dispose();
    expect([...callbacks.keys()]).toEqual(["Control+Command+B"]);
    for (const callback of staleCallbacks) callback();
    expect(execute).not.toHaveBeenCalled();
    expect(registry.unregister).toHaveBeenCalledTimes(2);
  });
});
describe("new quick-chat global shortcut", () => {
  it("dispatches, swaps, clears and disables all three commands independently", () => {
    const { controller, callbacks, registry, settings, execute, original } = fixture(false, true, true);
    for (const binding of [original, "Alt+Space", "Alt+Shift+Space"]) callbacks.get(binding)?.();
    expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"], ["quick-chat-new"]]);
    registry.register.mockClear();
    registry.unregister.mockClear();
    settings.bindings["quick-chat"] = "Alt+Shift+Space";
    settings.bindings["quick-chat-new"] = "Alt+Space";
    controller.update(settings, () => undefined);
    execute.mockClear();
    callbacks.get("Alt+Space")?.();
    callbacks.get("Alt+Shift+Space")?.();
    expect(execute.mock.calls).toEqual([["quick-chat-new"], ["quick-chat"]]);
    expect(registry.register).not.toHaveBeenCalled();
    expect(registry.unregister).not.toHaveBeenCalled();
    const staleNew = callbacks.get("Alt+Space");
    settings.bindings["quick-chat-new"] = null;
    controller.update(settings, () => undefined);
    expect([...callbacks.keys()]).toEqual([original, "Alt+Shift+Space"]);
    execute.mockClear();
    staleNew?.();
    expect(execute).not.toHaveBeenCalled();
    settings.enabled = false;
    controller.update(settings, () => undefined);
    expect(callbacks.size).toBe(0);
    settings.enabled = true;
    controller.update(settings, () => undefined);
    expect([...callbacks.keys()]).toEqual([original, "Alt+Shift+Space"]);
  });

  it.each(["Control+Command+T", "Alt+B", "Alt+Shift+B", "persistence"])(
    "rolls back every replacement when %s fails and leaves stale callbacks inert",
    (failure) => {
      const { controller, callbacks, registry, settings, execute, original } = fixture(false, true, true);
      settings.bindings["toggle-window"] = "Control+Command+T";
      settings.bindings["quick-chat"] = "Alt+B";
      settings.bindings["quick-chat-new"] = "Alt+Shift+B";
      const register = registry.register.getMockImplementation();
      registry.register
        .mockClear()
        .mockImplementation((key, callback) =>
          key === failure ? false : register?.(key, callback) === true,
        );
      const persist = vi.fn(() => {
        for (const binding of ["Control+Command+T", "Alt+B", "Alt+Shift+B"]) callbacks.get(binding)?.();
        expect(execute).not.toHaveBeenCalled();
        throw new Error("disk full");
      });
      expect(() => controller.update(settings, persist)).toThrow(
        failure === "persistence" ? "disk full" : "全局快捷键注册失败",
      );
      expect(persist).toHaveBeenCalledTimes(failure === "persistence" ? 1 : 0);
      expect([...callbacks.keys()]).toEqual([original, "Alt+Space", "Alt+Shift+Space"]);
      for (const [, callback] of registry.register.mock.calls) callback();
      expect(execute).not.toHaveBeenCalled();
      for (const callback of callbacks.values()) callback();
      expect(execute.mock.calls).toEqual([["toggle-window"], ["quick-chat"], ["quick-chat-new"]]);
    },
  );

  it.each(["toggle-window", "quick-chat", "quick-chat-new"] as const)(
    "restores other saved shortcuts while %s is occupied, retries it and disposes all three",
    (blocked) => {
      const { controller, callbacks, registry, settings, execute, ignoreMenuShortcuts } = fixture(
        false,
        true,
        true,
      );
      const stale = [...callbacks.values()];
      controller.setCapture(true);
      expect(callbacks.size).toBe(0);
      for (const callback of stale) callback();
      expect(execute).not.toHaveBeenCalled();
      const register = registry.register.getMockImplementation();
      registry.register.mockImplementation((key, callback) =>
        key === settings.bindings[blocked] ? false : register?.(key, callback) === true,
      );
      expect(() => controller.setCapture(false)).toThrow("全局快捷键注册失败");
      expect(controller.isCapturing).toBe(false);
      expect(ignoreMenuShortcuts).toHaveBeenLastCalledWith(false);
      expect(callbacks.size).toBe(2);
      expect(callbacks.has(settings.bindings[blocked] ?? "")).toBe(false);
      registry.register.mockImplementation(register ?? (() => false));
      controller.setCapture(false);
      expect(callbacks.size).toBe(3);
      for (const callback of stale) callback();
      expect(execute).not.toHaveBeenCalled();
      for (const callback of callbacks.values()) callback();
      expect(execute.mock.calls.map(([command]) => command).sort()).toEqual(
        ["toggle-window", "quick-chat", "quick-chat-new"].sort(),
      );
      execute.mockClear();
      const restored = [...callbacks.values()];
      const unrelated = vi.fn();
      registry.register("Control+Command+B", unrelated);
      controller.dispose();
      controller.dispose();
      controller.setCapture(false);
      expect([...callbacks.keys()]).toEqual(["Control+Command+B"]);
      for (const callback of restored) callback();
      expect(execute).not.toHaveBeenCalled();
    },
  );
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
    expect(forwardBrowserShortcut({ key: "[", metaKey: true }, "darwin", settings, send, focusHost)).toBe(
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
    expect(forwardBrowserShortcut({ key: "[", metaKey: true }, "darwin", settings, send, focusHost)).toBe(
      false,
    );
    expect(send).not.toHaveBeenCalled();
    expect(focusHost).not.toHaveBeenCalled();
  });
});

describe("menu shortcut window lifecycle", () => {
  function window() {
    const contents = {
      isDestroyed: vi.fn(() => false),
      setIgnoreMenuShortcuts: vi.fn(),
    };
    const target = {
      isDestroyed: vi.fn(() => false),
      get webContents() {
        if (target.isDestroyed()) throw new TypeError("Object has been destroyed");
        return contents;
      },
    };
    const getContents = vi.spyOn(target, "webContents", "get");
    return { target, contents, getContents };
  }

  it.each([true, false])("updates live menu capture state to %s", (ignore) => {
    const { target, contents } = window();
    setWindowMenuShortcutsIgnored(target, ignore);
    expect(contents.setIgnoreMenuShortcuts).toHaveBeenCalledExactlyOnceWith(ignore);
  });

  it("does not read webContents after its window is destroyed", () => {
    const { target, contents, getContents } = window();
    target.isDestroyed.mockReturnValue(true);
    expect(() => setWindowMenuShortcutsIgnored(target, false)).not.toThrow();
    expect(getContents).not.toHaveBeenCalled();
    expect(contents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  it("does not update destroyed webContents in a live window", () => {
    const { target, contents } = window();
    contents.isDestroyed.mockReturnValue(true);
    expect(() => setWindowMenuShortcutsIgnored(target, false)).not.toThrow();
    expect(contents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
  });

  it.each([true, false])("disposes safely after window destruction with recording %s", (recording) => {
    const { target, contents, getContents } = window();
    const registry = { register: vi.fn(() => true), unregister: vi.fn() };
    const controller = new ShortcutController(registry, "darwin", vi.fn(), false, (ignore) =>
      setWindowMenuShortcutsIgnored(target, ignore),
    );
    controller.initialize(defaultShortcuts("darwin"));
    if (recording) controller.setCapture(true);
    target.isDestroyed.mockReturnValue(true);
    getContents.mockClear();
    contents.setIgnoreMenuShortcuts.mockClear();
    expect(() => controller.dispose()).not.toThrow();
    expect(() => controller.dispose()).not.toThrow();
    controller.setCapture(false);
    expect(controller.isCapturing).toBe(false);
    expect(getContents).not.toHaveBeenCalled();
    expect(contents.setIgnoreMenuShortcuts).not.toHaveBeenCalled();
    const globals = shortcutCommands.filter(({ scope }) => scope === "global").length;
    expect(registry.register).toHaveBeenCalledTimes(globals);
    expect(registry.unregister).toHaveBeenCalledTimes(globals);
  });

  it("does not hide unexpected errors from live webContents", () => {
    const { target, contents } = window();
    contents.setIgnoreMenuShortcuts.mockImplementation(() => {
      throw new Error("unexpected failure");
    });
    expect(() => setWindowMenuShortcutsIgnored(target, false)).toThrow("unexpected failure");
  });
});
