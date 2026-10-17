import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { shortcutDefaultsVersion } from "../src/main/shortcut-defaults-migration.ts";
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
    expect(store.state.getSetting<SettingsData>("app")?.shortcutDefaultsVersion).toBe(
      shortcutDefaultsVersion,
    );
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

it.each([undefined, null, 0, 1, 3, "1"])(
  "rejects shortcut defaults version %s without online migration or state mutation",
  async (version) => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-version-"));
    const store = new SettingsStore(dir, encryption);
    try {
      store.updatePreferences({ theme: "dark" });
      const raw = store.state.getSetting<SettingsData>("app");
      store.state.setSetting("app", { ...raw, shortcutDefaultsVersion: version });
      const saved = store.state.getSetting("app");
      expect(() => new SettingsStore(dir, encryption, store.state)).toThrow(
        "Unsupported shortcut defaults version",
      );
      expect(store.state.getSetting("app")).toEqual(saved);
    } finally {
      store.close();
      await rm(dir, { recursive: true, force: true });
    }
  },
);

it("reads the additive task-menu default without rewriting old settings or stealing custom U", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-addition-"));
  const store = new SettingsStore(dir, encryption);
  try {
    store.updatePreferences({ theme: "dark" });
    const raw = store.state.getSetting<SettingsData>("app");
    if (!raw) throw new Error("Missing settings fixture");
    Reflect.deleteProperty(raw.shortcuts.bindings, "task-menu");
    for (const occupied of [false, true]) {
      raw.shortcuts.bindings["new-task"] = occupied ? "CmdOrCtrl+U" : "CmdOrCtrl+N";
      store.state.setSetting("app", raw);
      const next = new SettingsStore(dir, encryption, store.state);
      expect(next.get().shortcuts.bindings["task-menu"]).toBe(
        occupied ? null : defaultShortcuts(process.platform).bindings["task-menu"],
      );
      expect(store.state.getSetting("app")).toEqual(raw);
      next.updateShortcuts(next.get().shortcuts);
      expect(new SettingsStore(dir, encryption, store.state).get().shortcuts).toEqual(next.get().shortcuts);
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});

it("adds quick chat to existing settings without rewriting storage and preserves custom or cleared values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-shortcut-"));
  const store = new SettingsStore(dir, encryption);
  try {
    store.updatePreferences({ theme: "dark" });
    const raw = store.state.getSetting<SettingsData>("app");
    if (!raw) throw new Error("Missing settings fixture");
    Reflect.deleteProperty(raw.shortcuts.bindings, "quick-chat");
    Reflect.deleteProperty(raw.shortcuts.bindings, "task-menu");
    raw.shortcuts.enabled = false;
    store.state.setSetting("app", raw);
    const next = new SettingsStore(dir, encryption, store.state);
    expect(next.get().shortcuts).toEqual({ ...defaultShortcuts(process.platform), enabled: false });
    expect(next.get().interface.theme).toBe("dark");
    expect(store.state.getSetting("app")).toEqual(raw);
    for (const binding of [null, "Alt+B"]) {
      const settings = next.get().shortcuts;
      settings.bindings["quick-chat"] = binding;
      next.updateShortcuts(settings);
      const reopened = new SettingsStore(dir, encryption, store.state);
      expect(reopened.get().shortcuts.bindings["quick-chat"]).toBe(binding);
      expect(reopened.get().shortcuts.enabled).toBe(false);
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
