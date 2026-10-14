import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "../src/main/storage.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const encryption = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => "",
};
it("defaults missing legacy shortcuts without writing, then persists customization and master disable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-storage-"));
  try {
    const store = new SettingsStore(dir, encryption);
    store.updatePreferences({ theme: "dark" });
    const file = join(dir, "settings.json");
    const raw = JSON.parse(await readFile(file, "utf8"));
    delete raw.shortcuts;
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
