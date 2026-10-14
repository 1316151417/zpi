import { expect, it } from "vitest";
import { migrateLegacySettings } from "../../../scripts/storage-migration/legacy-settings.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

function fixture() {
  return {
    version: 4,
    providers: [],
    lastSelection: null,
    templates: [],
    selectedTemplateId: "pi",
    disabledSkillPaths: [],
    capabilities: { ...defaultCapabilities },
    interface: { ...defaultPreferences },
    shortcuts: defaultShortcuts(process.platform),
  };
}
it.each([true, false])(
  "migrates missing preferences, legacy font sizes and the retired question flag (%s) without mutating source",
  (enabled) => {
    for (const [legacy, pixels] of [
      ["small", 12],
      ["default", 14],
      ["large", 16],
    ] as const) {
      const raw = {
        ...fixture(),
        capabilities: { askUserQuestion: false },
        interface: { theme: "dark", fontSize: legacy, askUserQuestionAutoResolutionEnabled: enabled },
      };
      const before = JSON.stringify(raw);
      const migrated = migrateLegacySettings(raw);
      expect(migrated.interface).toMatchObject({
        theme: "dark",
        fontSize: pixels,
        notificationEnabled: true,
        notificationSoundEnabled: true,
      });
      expect(migrated.interface).not.toHaveProperty("askUserQuestionAutoResolutionEnabled");
      expect(migrated.capabilities).toEqual({
        ...defaultCapabilities,
        communicationStyle: true,
        askUserQuestion: false,
      });
      expect(JSON.stringify(raw)).toBe(before);
    }
  },
);
it("defaults absent shortcuts and migrates old defaults only once while preserving disabled state", () => {
  const raw = fixture();
  const { shortcuts: _, ...withoutShortcuts } = raw;
  expect(migrateLegacySettings(withoutShortcuts).shortcuts).toEqual(defaultShortcuts(process.platform));
  const bindings = raw.shortcuts.bindings as Record<string, string | null>;
  delete bindings["focus-composer"];
  Object.assign(bindings, {
    "toggle-pane": "CmdOrCtrl+K",
    "select-model": "CmdOrCtrl+L",
    search: "CmdOrCtrl+Shift+F",
  });
  raw.shortcuts.enabled = false;
  const migrated = migrateLegacySettings(raw);
  expect(migrated.shortcuts).toEqual({ ...defaultShortcuts(process.platform), enabled: false });
  Object.assign(migrated.shortcuts.bindings, raw.shortcuts.bindings);
  expect(migrateLegacySettings(migrated)).toEqual(migrated);
});
it.each(["CmdOrCtrl+;", "CmdOrCtrl+I"])(
  "preserves legacy custom %s and avoids a focus binding conflict",
  (binding) => {
    const raw = fixture();
    const bindings = raw.shortcuts.bindings as Record<string, string | null>;
    delete bindings["focus-composer"];
    Object.assign(bindings, {
      "toggle-pane": "CmdOrCtrl+K",
      "select-model": "CmdOrCtrl+L",
      search: "CmdOrCtrl+Shift+F",
      "new-task": binding,
    });
    const migrated = migrateLegacySettings(raw);
    expect(migrated.shortcuts.bindings["new-task"]).toBe(binding);
    expect(migrated.shortcuts.bindings["focus-composer"]).toBe(
      binding.endsWith("I") ? null : defaultShortcuts(process.platform).bindings["focus-composer"],
    );
    expect(migrateLegacySettings(migrated)).toEqual(migrated);
  },
);
it("migrates only eligible default bindings, keeping custom and cleared shortcuts", () => {
  const raw = fixture();
  Object.assign(raw.shortcuts.bindings, {
    "toggle-sidebar": "CmdOrCtrl+Shift+J",
    "toggle-pane": "CmdOrCtrl+K",
    "focus-composer": null,
    "select-model": null,
    search: "CmdOrCtrl+B",
  });
  raw.shortcuts.enabled = false;
  expect(migrateLegacySettings(raw).shortcuts).toEqual({
    enabled: false,
    bindings: {
      ...raw.shortcuts.bindings,
      "toggle-pane": defaultShortcuts(process.platform).bindings["toggle-pane"],
    },
  });
});
it("rejects unsupported versions, conflicting bindings and plaintext legacy credentials", () => {
  for (const version of [null, 0, 2, "1"])
    expect(() => migrateLegacySettings({ ...fixture(), shortcutDefaultsVersion: version })).toThrow(
      "Unsupported shortcut defaults version",
    );
  const raw = fixture();
  raw.shortcuts.bindings.search = raw.shortcuts.bindings["toggle-pane"];
  expect(() => migrateLegacySettings(raw)).toThrow("冲突");
  expect(() => migrateLegacySettings({ version: 1, apiKey: "secret" })).toThrow("Credentials");
  expect(() => migrateLegacySettings({ version: 1, headers: {} })).toThrow("Credentials");
});
it("converts single-provider and version 2/3 settings to the complete current shape", () => {
  const v1 = migrateLegacySettings({ baseUrl: "https://example.com/v1", modelId: "old" });
  expect(v1.providers[0].models[0]).toMatchObject({
    id: "old",
    contextWindow: 32768,
    maxTokens: 4096,
    reasoning: false,
    input: ["text"],
  });
  const v2 = migrateLegacySettings({ version: 2, providers: v1.providers });
  expect(v2.providers).toEqual(v1.providers);
  const v3 = migrateLegacySettings({
    version: 3,
    providers: v1.providers,
    lastSelection: { provider: "custom", modelId: "old", reasoning: "disabled" },
  });
  expect(v3).toMatchObject({
    version: 4,
    templates: [],
    selectedTemplateId: "pi",
    disabledSkillPaths: [],
    lastSelection: null,
  });
});
