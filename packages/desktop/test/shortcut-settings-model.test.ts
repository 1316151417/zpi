import { describe, expect, it } from "vitest";
import { matchesShortcutSearch } from "../src/renderer/shortcut-settings-model.ts";
import { shortcutLabelParts } from "../src/shared/shortcuts.ts";

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
