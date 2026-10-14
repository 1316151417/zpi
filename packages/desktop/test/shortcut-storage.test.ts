import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { SettingsStore } from "../src/main/storage.ts";
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
