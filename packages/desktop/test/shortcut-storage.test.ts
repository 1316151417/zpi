import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { type SettingsData, SettingsStore } from "../src/main/storage.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

const encryption = {
  isEncryptionAvailable: () => false,
  encryptString: () => Buffer.alloc(0),
  decryptString: () => "",
};
it("persists custom shortcuts and master disable in the shared state database", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-storage-"));
  const store = new SettingsStore(dir, encryption);
  try {
    expect(store.get().shortcuts).toEqual(defaultShortcuts(process.platform));
    const custom = store.get().shortcuts;
    custom.bindings["toggle-sidebar"] = null;
    custom.bindings["toggle-pane"] = "CmdOrCtrl+Shift+T";
    custom.enabled = false;
    store.updateShortcuts(custom);
    expect(new SettingsStore(dir, encryption, store.state).get().shortcuts).toEqual(store.get().shortcuts);
    const previous = store.get();
    const raw = store.state.getSetting("app");
    const invalid = store.get().shortcuts;
    invalid.bindings["toggle-pane"] = invalid.bindings["new-task"];
    expect(() => store.updateShortcuts(invalid)).toThrow("冲突");
    expect(store.get()).toEqual(previous);
    expect(store.state.getSetting("app")).toEqual(raw);
    const fail = vi.spyOn(store.state, "setSetting").mockImplementation(() => {
      throw new Error("commit failed");
    });
    expect(() => store.updateShortcuts({ ...previous.shortcuts, enabled: true })).toThrow("commit failed");
    expect(store.get()).toEqual(previous);
    fail.mockRestore();
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("uses current menu defaults and preserves explicitly restored old keys or cleared shortcuts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-current-"));
  const store = new SettingsStore(dir, encryption);
  try {
    store.updatePreferences({ theme: "dark" });
    const defaults = defaultShortcuts(process.platform);
    expect(store.get().shortcuts).toEqual(defaults);
    const custom = store.get().shortcuts;
    custom.enabled = false;
    Object.assign(custom.bindings, {
      "configure-environment": null,
      "toggle-sidebar": "CmdOrCtrl+J",
      "toggle-pane": "CmdOrCtrl+Shift+T",
      "select-model": "CmdOrCtrl+;",
      "focus-composer": null,
    });
    store.updateShortcuts(custom);
    const saved = store.state.getSetting<SettingsData>("app");
    const reopened = new SettingsStore(dir, encryption, store.state);
    expect(reopened.get().shortcuts).toEqual(store.get().shortcuts);
    expect(reopened.get().interface.theme).toBe("dark");
    expect(store.state.getSetting("app")).toEqual(saved);
    reopened.updateShortcuts(defaults);
    expect(reopened.get().shortcuts).toEqual(defaults);
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "opens existing shortcut settings without resetting user bindings (default occupied=%s)",
  async (occupied) => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-fast-mode-"));
    const store = new SettingsStore(dir, encryption);
    try {
      store.updatePreferences({ theme: "dark" });
      const raw = store.state.getSetting<SettingsData>("app");
      if (!raw) throw new Error("Missing saved settings");
      const { "toggle-fast-mode": _newAction, ...bindings } = raw.shortcuts.bindings;
      Object.assign(bindings, {
        "select-model": null,
        "toggle-pane": occupied ? "CmdOrCtrl+Shift+L" : "CmdOrCtrl+Shift+T",
      });
      const previous = { enabled: false, bindings };
      store.state.setSetting("app", { ...raw, shortcuts: previous });
      const reopened = new SettingsStore(dir, encryption, store.state);
      const actual = reopened.get().shortcuts;
      expect(actual.enabled).toBe(false);
      expect(actual.bindings["select-model"]).toBeNull();
      expect(actual.bindings["toggle-pane"]).toBe(
        occupied
          ? defaultShortcuts(process.platform).bindings["toggle-fast-mode"]
          : process.platform === "darwin"
            ? "Shift+Command+T"
            : "Control+Shift+T",
      );
      expect(actual.bindings["toggle-fast-mode"]).toBe(
        occupied ? null : defaultShortcuts(process.platform).bindings["toggle-fast-mode"],
      );
      reopened.updateShortcuts(actual);
      expect(new SettingsStore(dir, encryption, store.state).get().shortcuts).toEqual(actual);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);
