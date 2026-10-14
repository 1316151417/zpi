import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { shortcutDefaultsVersion } from "../src/main/shortcut-defaults-migration.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const encryption = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => "",
};
it("upgrades a version 1 file once and retains later custom or cleared menu shortcuts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-composer-menu-migration-"));
  try {
    new SettingsStore(dir, encryption).updatePreferences({ theme: "dark" });
    const file = join(dir, "settings.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.shortcutDefaultsVersion = 1;
    delete raw.shortcuts.bindings["configure-environment"];
    Object.assign(raw.shortcuts.bindings, {
      "toggle-sidebar": "CmdOrCtrl+J",
      "toggle-pane": "CmdOrCtrl+L",
      "select-model": "CmdOrCtrl+;",
    });
    await writeFile(file, JSON.stringify(raw));
    const store = new SettingsStore(dir, encryption);
    expect(store.get().shortcuts).toEqual(defaultShortcuts(process.platform));
    expect(JSON.parse(await readFile(file, "utf8")).shortcutDefaultsVersion).toBe(shortcutDefaultsVersion);
    const bytes = await readFile(file, "utf8");
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(store.get().shortcuts);
    expect(await readFile(file, "utf8")).toBe(bytes);
    const custom = store.get().shortcuts;
    custom.bindings["configure-environment"] = null;
    custom.bindings["toggle-sidebar"] = "CmdOrCtrl+J";
    custom.bindings["select-model"] = "CmdOrCtrl+;";
    store.updateShortcuts(custom);
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(store.get().shortcuts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("defaults missing legacy shortcuts without writing, then persists customization and master disable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-storage-"));
  try {
    const store = new SettingsStore(dir, encryption);
    store.updatePreferences({ theme: "dark" });
    const file = join(dir, "settings.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.shortcuts;
    delete raw.shortcutDefaultsVersion;
    const legacy = JSON.stringify(raw);
    await writeFile(file, legacy);
    const restored = new SettingsStore(dir, encryption);
    expect(restored.get().shortcuts).toEqual(defaultShortcuts(process.platform));
    expect(await readFile(file, "utf8")).toBe(legacy);
    const custom = restored.get().shortcuts;
    custom.bindings["toggle-sidebar"] = null;
    custom.bindings["toggle-pane"] = "CmdOrCtrl+Shift+T";
    custom.enabled = false;
    restored.updateShortcuts(custom);
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(restored.get().shortcuts);
    expect(restored.get().interface.theme).toBe("dark");
    restored.updateShortcuts(defaultShortcuts(process.platform));
    expect(restored.get().shortcuts.enabled).toBe(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("migrates persisted legacy defaults once, preserving disabled state, credentials and later old-key choices", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-migration-"));
  try {
    const store = new SettingsStore(dir, encryption);
    store.updatePreferences({ theme: "dark" });
    const file = join(dir, "settings.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.shortcutDefaultsVersion;
    delete raw.shortcuts.bindings["focus-composer"];
    delete raw.shortcuts.bindings["configure-environment"];
    Object.assign(raw.shortcuts.bindings, {
      "toggle-sidebar": "CmdOrCtrl+J",
      "toggle-pane": "CmdOrCtrl+K",
      "select-model": "CmdOrCtrl+L",
      search: "CmdOrCtrl+Shift+F",
    });
    raw.shortcuts.enabled = false;
    await writeFile(file, JSON.stringify(raw));
    const creds = join(dir, "credentials.enc");
    await writeFile(creds, "unavailable encrypted credentials");
    const migrated = new SettingsStore(dir, encryption);
    expect(migrated.get().shortcuts).toEqual({ ...defaultShortcuts(process.platform), enabled: false });
    expect(migrated.get().interface.theme).toBe("dark");
    expect(JSON.parse(await readFile(file, "utf8")).shortcutDefaultsVersion).toBe(shortcutDefaultsVersion);
    expect(await readFile(creds, "utf8")).toBe("unavailable encrypted credentials");
    const saved = await readFile(file, "utf8");
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(migrated.get().shortcuts);
    expect(await readFile(file, "utf8")).toBe(saved);
    const chosenOldKeys = migrated.get().shortcuts;
    chosenOldKeys.bindings["configure-environment"] = null;
    Object.assign(chosenOldKeys.bindings, raw.shortcuts.bindings);
    migrated.updateShortcuts(chosenOldKeys);
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(migrated.get().shortcuts);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it.each(["CmdOrCtrl+;", "CmdOrCtrl+I"])(
  "preserves a legacy custom %s binding and safely adds focus-composer",
  async (binding) => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-migration-conflict-"));
    try {
      new SettingsStore(dir, encryption).updatePreferences({ theme: "dark" });
      const file = join(dir, "settings.json");
      const raw = JSON.parse(await readFile(file, "utf8"));
      delete raw.shortcutDefaultsVersion;
      delete raw.shortcuts.bindings["focus-composer"];
      Object.assign(raw.shortcuts.bindings, {
        "toggle-pane": "CmdOrCtrl+K",
        "select-model": "CmdOrCtrl+L",
        search: "CmdOrCtrl+Shift+F",
        "new-task": binding,
      });
      await writeFile(file, JSON.stringify(raw));
      const migrated = new SettingsStore(dir, encryption);
      const shortcuts = migrated.get().shortcuts;
      expect(shortcuts.bindings["new-task"]).toBe(binding);
      const defaults = defaultShortcuts(process.platform).bindings;
      if (binding.endsWith(";")) {
        expect(shortcuts.bindings).toEqual({
          ...raw.shortcuts.bindings,
          "focus-composer": defaults["focus-composer"],
        });
      } else {
        expect(shortcuts.bindings).toEqual({ ...defaults, "new-task": binding, "focus-composer": null });
      }
      expect(JSON.parse(await readFile(file, "utf8")).shortcutDefaultsVersion).toBe(shortcutDefaultsVersion);
      expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(shortcuts);
      // A later edit that removes a conflict must not trigger deferred default migration.
      shortcuts.bindings["new-task"] = null;
      migrated.updateShortcuts(shortcuts);
      expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(migrated.get().shortcuts);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("persists a partial migration without changing custom, cleared or disabled settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-partial-migration-"));
  try {
    new SettingsStore(dir, encryption).updatePreferences({ theme: "dark" });
    const file = join(dir, "settings.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.shortcutDefaultsVersion;
    Object.assign(raw.shortcuts.bindings, {
      "toggle-sidebar": "CmdOrCtrl+Shift+J",
      "toggle-pane": "CmdOrCtrl+K",
      "focus-composer": null,
      "select-model": null,
      search: "CmdOrCtrl+B",
    });
    raw.shortcuts.enabled = false;
    await writeFile(file, JSON.stringify(raw));
    const expected = {
      enabled: false,
      bindings: {
        ...raw.shortcuts.bindings,
        "toggle-pane": defaultShortcuts(process.platform).bindings["toggle-pane"],
      },
    };
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(expected);
    expect(JSON.parse(await readFile(file, "utf8")).shortcuts).toEqual(expected);
    expect(new SettingsStore(dir, encryption).get().shortcuts).toEqual(expected);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects invalid legacy bindings and unknown migration versions without rewriting them", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-invalid-migration-"));
  try {
    new SettingsStore(dir, encryption).updatePreferences({ theme: "dark" });
    const file = join(dir, "settings.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    for (const version of [null, 0, 3, "1"]) {
      const bytes = JSON.stringify({ ...raw, shortcutDefaultsVersion: version });
      await writeFile(file, bytes);
      expect(() => new SettingsStore(dir, encryption)).toThrow("Unsupported shortcut defaults version");
      expect(await readFile(file, "utf8")).toBe(bytes);
    }
    delete raw.shortcutDefaultsVersion;
    delete raw.shortcuts.bindings["focus-composer"];
    raw.shortcuts.bindings.search = raw.shortcuts.bindings["toggle-pane"];
    const bytes = JSON.stringify(raw);
    await writeFile(file, bytes);
    expect(() => new SettingsStore(dir, encryption)).toThrow("冲突");
    expect(await readFile(file, "utf8")).toBe(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
it("does not change public state or disk after invalid settings or failed persistence", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-rollback-"));
  try {
    const store = new SettingsStore(dir, encryption);
    store.updatePreferences({ theme: "dark" });
    const previous = store.get();
    const file = join(dir, "settings.json");
    const bytes = await readFile(file, "utf8");
    const invalid = store.get().shortcuts;
    invalid.bindings["toggle-pane"] = invalid.bindings["toggle-sidebar"];
    expect(() => store.updateShortcuts(invalid)).toThrow("冲突");
    expect(store.get()).toEqual(previous);
    expect(await readFile(file, "utf8")).toBe(bytes);
    await rename(dir, `${dir}-saved`);
    await writeFile(dir, "not a directory");
    expect(() => store.updateShortcuts({ ...previous.shortcuts, enabled: false })).toThrow();
    expect(store.get()).toEqual(previous);
    expect(await readFile(join(`${dir}-saved`, "settings.json"), "utf8")).toBe(bytes);
  } finally {
    await rm(dir, { recursive: true, force: true });
    await rm(`${dir}-saved`, { recursive: true, force: true });
  }
});
