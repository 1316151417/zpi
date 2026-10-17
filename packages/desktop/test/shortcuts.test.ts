import { describe, expect, it } from "vitest";
import {
  defaultShortcuts,
  formatShortcut,
  normalizeShortcut,
  normalizeShortcuts,
  shortcutCommands,
  shortcutForEvent,
  shortcutFromEvent,
  validateShortcuts,
  withQuickChatShortcut,
} from "../src/shared/shortcuts.ts";

describe("shortcut contract", () => {
  it.each(["darwin", "win32", "linux"])(
    "provides complete, valid independent defaults for %s",
    (platform) => {
      const settings = defaultShortcuts(platform);
      expect(validateShortcuts(settings, platform)).toBeUndefined();
      expect(Object.keys(settings.bindings)).toHaveLength(shortcutCommands.length);
      expect(settings.bindings["toggle-window"]).toBe(
        platform === "darwin" ? "Control+Command+E" : "Control+Alt+E",
      );
      const primary = platform === "darwin" ? "Command" : "Control";
      expect(settings.bindings).toMatchObject({
        "quick-chat": "Alt+N",
        "toggle-sidebar": `${primary}+[`,
        "toggle-pane": `${primary}+]`,
        search: `${primary}+K`,
        "configure-environment": `${primary}+J`,
        "select-model": `${primary}+L`,
        "focus-composer": `${primary}+I`,
      });
      settings.bindings["toggle-sidebar"] = null;
      expect(defaultShortcuts(platform).bindings["toggle-sidebar"]).not.toBeNull();
    },
  );
  it("normalizes aliases and ordering across the platform primary modifier", () => {
    expect(normalizeShortcut("cmdorctrl + shift + f", "darwin")).toBe("Shift+Command+F");
    expect(normalizeShortcut("CommandOrControl+Alt+E", "linux")).toBe("Control+Alt+E");
    expect(normalizeShortcut("Option+Ctrl+return", "darwin")).toBe("Control+Alt+Enter");
    expect(normalizeShortcut("Meta+Cmd+J", "darwin")).toBeUndefined();
    expect(normalizeShortcut("CmdOrCtrl+Control+J", "linux")).toBeUndefined();
    expect(normalizeShortcuts(defaultShortcuts("darwin"), "darwin").bindings.search).toBe("Command+K");
    expect(normalizeShortcut("CmdOrCtrl+;", "darwin")).toBe("Command+;");
  });
  it.each(["darwin", "win32", "linux"])(
    "routes the new default map and physical semicolon on %s",
    (platform) => {
      const settings = defaultShortcuts(platform);
      const modifiers = { metaKey: platform === "darwin", ctrlKey: platform !== "darwin" };
      for (const [key, command] of [
        ["[", "toggle-sidebar"],
        ["]", "toggle-pane"],
        ["k", "search"],
        ["j", "configure-environment"],
        ["l", "select-model"],
        ["i", "focus-composer"],
      ])
        expect(shortcutForEvent({ key, ...modifiers }, platform, settings)).toBe(command);
      settings.bindings["select-model"] = "CmdOrCtrl+;";
      const semicolon = { key: "；", code: "Semicolon", ...modifiers };
      const binding = platform === "darwin" ? "Command+;" : "Control+;";
      expect(shortcutFromEvent(semicolon, platform)).toBe(binding);
      expect(shortcutForEvent(semicolon, platform, settings)).toBe("select-model");
      for (const extra of [{ shiftKey: true }, { altKey: true }, { repeat: true }, { isComposing: true }])
        expect(shortcutForEvent({ ...semicolon, ...extra }, platform, settings)).toBeUndefined();
      expect(
        shortcutForEvent({ key: "f", shiftKey: true, ...modifiers }, platform, settings),
      ).toBeUndefined();
      expect(formatShortcut(binding, platform)).toBe(platform === "darwin" ? "⌘;" : "Ctrl+;");
    },
  );
  it.each(["Command", "Command++J", "Command+Unknown", "J+Control", "Control+A+B", "", "Control+F25"])(
    "rejects malformed accelerator %s",
    (binding) => expect(normalizeShortcut(binding, "darwin")).toBeUndefined(),
  );
  it("matches exact modifiers, physical letters, uppercase, and disabled commands", () => {
    const settings = defaultShortcuts("darwin");
    expect(shortcutForEvent({ key: "j", metaKey: true }, "darwin", settings)).toBe("configure-environment");
    expect(shortcutForEvent({ key: "J", metaKey: true }, "darwin", settings)).toBe("configure-environment");
    expect(shortcutForEvent({ key: "j", ctrlKey: true }, "darwin", settings)).toBeUndefined();
    expect(shortcutForEvent({ key: "j", metaKey: true, altKey: true }, "darwin", settings)).toBeUndefined();
    expect(shortcutForEvent({ key: "j", metaKey: true, repeat: true }, "darwin", settings)).toBeUndefined();
    expect(
      shortcutForEvent({ key: "j", metaKey: true, isComposing: true }, "darwin", settings),
    ).toBeUndefined();
    expect(shortcutFromEvent({ key: "†", code: "KeyT", altKey: true, metaKey: true }, "darwin")).toBe(
      "Alt+Command+T",
    );
    expect(shortcutFromEvent({ key: "Dead", code: "KeyE", altKey: true }, "darwin")).toBeNull();
    expect(shortcutFromEvent({ key: "Control", ctrlKey: true }, "linux")).toBeNull();
    settings.bindings["configure-environment"] = null;
    expect(shortcutForEvent({ key: "j", metaKey: true }, "darwin", settings)).toBeUndefined();
    settings.enabled = false;
    expect(shortcutForEvent({ key: "k", metaKey: true }, "darwin", settings)).toBeUndefined();
  });
  it("rejects duplicate bindings even through aliases", () => {
    const settings = defaultShortcuts("darwin");
    settings.bindings["toggle-pane"] = "CmdOrCtrl+J";
    expect(validateShortcuts(settings, "darwin")).toContain("冲突");
  });
  it.each([
    "Command+C",
    "Command+Shift+V",
    "Command+W",
    "Command+Q",
    "Command+R",
    "Command+Left",
    "Control+A",
    "Command+Space",
    "Command+Shift+4",
    "Alt+A",
    "Shift+J",
    "J",
    "Escape",
    "Control+Alt+Delete",
    "Alt+F4",
    "F5",
    "F6",
    "F11",
    "F12",
    "Command+Alt+C",
    "Command+Alt+I",
    "Control+Command+Q",
    "Control+Command+F",
  ])("reserves native editing and system accelerator %s", (binding) => {
    const settings = defaultShortcuts("darwin");
    settings.bindings["toggle-pane"] = binding;
    expect(validateShortcuts(settings, "darwin")).toBeTypeOf("string");
  });
  it("reserves the platform developer-tools menu accelerator", () => {
    const settings = defaultShortcuts("linux");
    settings.bindings["toggle-pane"] = "Control+Shift+I";
    expect(validateShortcuts(settings, "linux")).toContain("保留");
  });
  it("allows removing every binding and resetting to defaults", () => {
    const settings = defaultShortcuts("linux");
    for (const { id } of shortcutCommands) settings.bindings[id] = null;
    expect(validateShortcuts(settings, "linux")).toBeUndefined();
    expect(validateShortcuts(defaultShortcuts("linux"), "linux")).toBeUndefined();
  });
  it("validates the full untrusted IPC shape", () => {
    const valid = defaultShortcuts("linux");
    for (const invalid of [
      null,
      [],
      {},
      { ...valid, enabled: "true" },
      { ...valid, extra: true },
      { ...valid, bindings: {} },
      { ...valid, bindings: [] },
      { ...valid, bindings: { ...valid.bindings, unknown: null } },
      { ...valid, bindings: { ...valid.bindings, find: 5 } },
    ])
      expect(validateShortcuts(invalid, "linux")).toBeTypeOf("string");
  });
  it("formats platform modifiers and unbound commands", () => {
    expect(formatShortcut("Control+Command+E", "darwin")).toBe("⌃⌘E");
    expect(formatShortcut("CmdOrCtrl+Alt+E", "linux")).toBe("Ctrl+Alt+E");
    expect(formatShortcut(null, "darwin")).toBe("未设置");
  });
});

describe.each(["darwin", "win32", "linux"])("quick-chat shortcut on %s", (platform) => {
  it("allows Alt plus a letter only for quick chat and preserves other reserved keys", () => {
    const settings = defaultShortcuts(platform);
    for (const binding of ["Alt+A", "Option+N", "Alt+Z"]) {
      settings.bindings["quick-chat"] = binding;
      expect(validateShortcuts(settings, platform)).toBeUndefined();
      settings.bindings["toggle-window"] = binding;
      expect(validateShortcuts(settings, platform)).toContain("Ctrl 或 Command");
      settings.bindings["toggle-window"] = defaultShortcuts(platform).bindings["toggle-window"];
    }
    for (const binding of ["Alt+1", "Alt+Shift+N", "Alt+Tab", "Alt+F4", "Alt+Space", "N"]) {
      settings.bindings["quick-chat"] = binding;
      expect(validateShortcuts(settings, platform)).toBeTypeOf("string");
    }
  });

  it("records the physical Option+N dead key without changing ordinary IME or dead-key handling", () => {
    const event = { key: "Dead", code: "KeyN", altKey: true };
    expect(shortcutFromEvent(event, platform)).toBeNull();
    expect(shortcutFromEvent(event, platform, true)).toBe("Alt+N");
    expect(shortcutForEvent(event, platform, defaultShortcuts(platform))).toBe("quick-chat");
    for (const extra of [{ isComposing: true }, { repeat: true }, { altKey: false }])
      expect(shortcutFromEvent({ ...event, ...extra }, platform, true)).toBeNull();
    expect(shortcutFromEvent({ ...event, key: "Process" }, platform, true)).toBeNull();
  });

  it("adds the default without changing an explicit custom or cleared quick-chat binding", () => {
    for (const binding of [null, "Alt+B"]) {
      const settings = defaultShortcuts(platform);
      settings.bindings["quick-chat"] = binding;
      expect(withQuickChatShortcut(settings, platform)).toBe(settings);
    }
    const settings = defaultShortcuts(platform);
    Reflect.deleteProperty(settings.bindings, "quick-chat");
    const snapshot = structuredClone(settings);
    expect(withQuickChatShortcut(settings, platform)).toEqual(defaultShortcuts(platform));
    expect(settings).toEqual(snapshot);
    settings.bindings["new-task"] = "Option+N";
    expect(withQuickChatShortcut(settings, platform).bindings["quick-chat"]).toBeNull();
  });
});
