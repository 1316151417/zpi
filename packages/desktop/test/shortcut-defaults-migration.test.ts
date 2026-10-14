import { describe, expect, it } from "vitest";
import { migrateShortcutDefaults } from "../src/main/shortcut-defaults-migration.ts";
import { defaultShortcuts, type ShortcutSettings, validateShortcuts } from "../src/shared/shortcuts.ts";

function legacyShortcuts(platform: string): ShortcutSettings {
  const settings = defaultShortcuts(platform);
  settings.bindings["toggle-pane"] = "CmdOrCtrl+K";
  settings.bindings["select-model"] = "CmdOrCtrl+L";
  settings.bindings.search = "CmdOrCtrl+Shift+F";
  return settings;
}

describe.each(["darwin", "win32", "linux"])("shortcut default migration on %s", (platform) => {
  it("upgrades the legacy map together without mutating the input", () => {
    const original = legacyShortcuts(platform);
    const snapshot = structuredClone(original);
    expect(migrateShortcutDefaults(original, platform)).toEqual(defaultShortcuts(platform));
    expect(original).toEqual(snapshot);
  });

  it.each(["toggle-pane", "select-model", "search"] as const)(
    "preserves custom and cleared %s bindings, other commands and the master switch",
    (command) => {
      for (const binding of [null, "CmdOrCtrl+Shift+B"]) {
        const original = legacyShortcuts(platform);
        original.bindings[command] = binding;
        original.bindings["toggle-sidebar"] = "CmdOrCtrl+Shift+J";
        original.enabled = false;
        const expected = defaultShortcuts(platform);
        expected.bindings[command] = binding;
        expected.bindings["toggle-sidebar"] = original.bindings["toggle-sidebar"];
        expected.enabled = false;
        const migrated = migrateShortcutDefaults(original, platform);
        expect(migrated).toEqual(expected);
        expect(validateShortcuts(migrated, platform)).toBeUndefined();
      }
    },
  );

  it("keeps the whole old layout when a custom command owns a new default", () => {
    const original = legacyShortcuts(platform);
    original.bindings["new-task"] = "CmdOrCtrl+;";
    expect(validateShortcuts(original, platform)).toBeUndefined();
    expect(migrateShortcutDefaults(original, platform)).toBe(original);
  });

  it("preserves interdependent customized commands rather than partially migrating", () => {
    const original = legacyShortcuts(platform);
    original.bindings["select-model"] = null;
    original.bindings.search = "CmdOrCtrl+L";
    expect(validateShortcuts(original, platform)).toBeUndefined();
    expect(migrateShortcutDefaults(original, platform)).toBe(original);
  });

  it("leaves an already updated map unchanged", () => {
    const settings = defaultShortcuts(platform);
    expect(migrateShortcutDefaults(settings, platform)).toEqual(settings);
  });
});
