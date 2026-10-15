import { describe, expect, it } from "vitest";
import { matchesShortcutSearch } from "../src/renderer/shortcut-settings-model.ts";
import {
  defaultShortcuts,
  shortcutLabelParts,
  validateShortcuts,
  withTaskMenuShortcut,
} from "../src/shared/shortcuts.ts";

describe("shortcut search", () => {
  it.each(["模型", "Command + L", "cmd+l", "⌘L", "meta L"])(
    "matches command names and key text: %s",
    (query) => {
      expect(matchesShortcutSearch("选择模型", "Command+L", query, null, "darwin")).toBe(true);
    },
  );
  it("combines text and exact physical-key filters, and supports unset bindings", () => {
    expect(matchesShortcutSearch("模型", "CmdOrCtrl+L", "模型", "Command+L", "darwin")).toBe(true);
    expect(matchesShortcutSearch("模型", "Shift+Command+L", "", "Command+L", "darwin")).toBe(false);
    expect(matchesShortcutSearch("模型", null, "", "Command+L", "darwin")).toBe(false);
    expect(matchesShortcutSearch("模型", null, "未设置", null, "darwin")).toBe(true);
    expect(matchesShortcutSearch("模型", "Control+L", "ctrl+l", null, "win32")).toBe(true);
    expect(shortcutLabelParts("Control+Alt+Shift+Command+L", "darwin")).toEqual(["⌃", "⌥", "⇧", "⌘", "L"]);
  });
});

describe.each(["darwin", "win32", "linux"])("additive task menu default on %s", (platform) => {
  it("fills only the missing command, preserving an occupied U and explicit clears", () => {
    const old = defaultShortcuts(platform);
    const binding = old.bindings["task-menu"];
    Reflect.deleteProperty(old.bindings, "task-menu");
    expect(withTaskMenuShortcut(old, platform).bindings["task-menu"]).toBe(binding);
    old.bindings["new-task"] = binding;
    const next = withTaskMenuShortcut(old, platform);
    expect(next.bindings["task-menu"]).toBeNull();
    expect(next.bindings["new-task"]).toBe(binding);
    expect(validateShortcuts(next, platform)).toBeUndefined();
    expect(withTaskMenuShortcut(next, platform)).toBe(next);
    expect(Object.hasOwn(old.bindings, "task-menu")).toBe(false);
  });
});
