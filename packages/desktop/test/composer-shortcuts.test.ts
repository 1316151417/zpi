import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composerShortcutCommand } from "../src/renderer/composer-shortcuts.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const querySelectorAll = vi.fn(() => [] as unknown[]);
function event(overrides: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return {
    key: "Enter",
    code: "Enter",
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
    defaultPrevented: false,
    keyCode: 13,
    ...overrides,
  } as KeyboardEvent;
}

describe("composer shortcut routing", () => {
  beforeEach(() => {
    querySelectorAll.mockReturnValue([]);
    vi.stubGlobal("document", { querySelectorAll });
    vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible" }));
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the configured platform shortcut and ignores app-wide commands", () => {
    expect(composerShortcutCommand(event(), "linux", defaultShortcuts("linux"))).toBe("send-next");
    expect(
      composerShortcutCommand(event({ ctrlKey: false, metaKey: true }), "darwin", defaultShortcuts("darwin")),
    ).toBe("send-next");
    expect(
      composerShortcutCommand(event({ key: "l", code: "KeyL" }), "linux", defaultShortcuts("linux")),
    ).toBe("select-model");
    for (const key of ["j", "k", "n", "f", "1"])
      expect(
        composerShortcutCommand(event({ key, code: undefined }), "linux", defaultShortcuts("linux")),
      ).toBeUndefined();
  });

  it("recognizes repeats for consumption without allowing them to fall through as normal Enter", () => {
    expect(composerShortcutCommand(event({ repeat: true }), "linux", defaultShortcuts("linux"))).toBe(
      "send-next",
    );
  });

  it.each([{ isComposing: true }, { keyCode: 229 }, { defaultPrevented: true }])(
    "leaves composition and already handled events alone: %j",
    (overrides) => {
      expect(composerShortcutCommand(event(overrides), "linux", defaultShortcuts("linux"))).toBeUndefined();
    },
  );

  it("does not steal commands from dialogs, menus, listboxes, or settings", () => {
    querySelectorAll.mockReturnValue([{ closest: () => null, getClientRects: () => [{}] }]);
    expect(composerShortcutCommand(event(), "linux", defaultShortcuts("linux"))).toBeUndefined();
    expect(querySelectorAll).toHaveBeenCalledWith(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .command-panel, .settings-screen, [data-shortcut-recording="true"]',
    );
  });

  it("applies disabled, unbound, and remapped settings immediately", () => {
    const settings = defaultShortcuts("linux");
    expect(composerShortcutCommand(event(), "linux", undefined)).toBeUndefined();
    expect(composerShortcutCommand(event(), "linux", { ...settings, enabled: false })).toBeUndefined();
    settings.bindings["send-next"] = null;
    expect(composerShortcutCommand(event(), "linux", settings)).toBeUndefined();
    settings.bindings["send-next"] = "Control+Shift+Enter";
    expect(composerShortcutCommand(event(), "linux", settings)).toBeUndefined();
    expect(composerShortcutCommand(event({ shiftKey: true }), "linux", settings)).toBe("send-next");
  });
});
