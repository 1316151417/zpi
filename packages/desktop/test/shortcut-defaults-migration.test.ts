import { describe, expect, it } from "vitest";
import { migrateShortcutDefaults } from "../src/main/shortcut-defaults-migration.ts";
import { defaultShortcuts, type ShortcutSettings, validateShortcuts } from "../src/shared/shortcuts.ts";

function legacyShortcuts(platform: string): ShortcutSettings {
  const settings = defaultShortcuts(platform);
  settings.bindings["configure-environment"] = null;
  settings.bindings["toggle-sidebar"] = "CmdOrCtrl+J";
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

  it("adds quick chat before validating a legacy map without it", () => {
    const settings = legacyShortcuts(platform);
    Reflect.deleteProperty(settings.bindings, "quick-chat");
    expect(migrateShortcutDefaults(settings, platform)).toEqual(defaultShortcuts(platform));
    expect(Object.hasOwn(settings.bindings, "quick-chat")).toBe(false);
  });

  it("leaves an already updated map unchanged", () => {
    const settings = defaultShortcuts(platform);
    expect(migrateShortcutDefaults(settings, platform)).toEqual(settings);
  });
  it("migrates version 1 sidebar and model defaults while adding environment settings", () => {
    const original = defaultShortcuts(platform);
    Object.assign(original.bindings, {
      "toggle-sidebar": "CmdOrCtrl+J",
      "toggle-pane": "CmdOrCtrl+L",
      "select-model": "CmdOrCtrl+;",
      "configure-environment": null,
    });
    expect(migrateShortcutDefaults(original, platform, 1)).toEqual(defaultShortcuts(platform));
  });
  it("keeps version 1 custom bindings and leaves environment unbound when J is occupied", () => {
    const original = defaultShortcuts(platform);
    Object.assign(original.bindings, {
      "toggle-sidebar": "CmdOrCtrl+Shift+J",
      "toggle-pane": "CmdOrCtrl+L",
      "select-model": "CmdOrCtrl+J",
      "configure-environment": null,
    });
    const expected = structuredClone(original);
    expected.bindings["toggle-pane"] = defaultShortcuts(platform).bindings["toggle-pane"];
    expect(migrateShortcutDefaults(original, platform, 1)).toEqual(expected);
  });
  it("preserves all version 1 bindings when brackets conflict with a custom shortcut", () => {
    const original = defaultShortcuts(platform);
    Object.assign(original.bindings, {
      "toggle-sidebar": "CmdOrCtrl+J",
      "toggle-pane": "CmdOrCtrl+L",
      "select-model": "CmdOrCtrl+;",
      "configure-environment": null,
      "new-task": "CmdOrCtrl+[",
    });
    expect(migrateShortcutDefaults(original, platform, 1)).toBe(original);
  });
  it("does not rebind a cleared environment shortcut in the current version", () => {
    const settings = defaultShortcuts(platform);
    settings.bindings["configure-environment"] = null;
    expect(migrateShortcutDefaults(settings, platform, 2)).toEqual(settings);
  });
});
