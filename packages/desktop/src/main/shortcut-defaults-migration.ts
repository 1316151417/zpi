import {
  defaultShortcuts,
  normalizeShortcut,
  type ShortcutSettings,
  validateShortcuts,
  withQuickChatShortcut,
} from "../shared/shortcuts.ts";

export const shortcutDefaultsVersion = 2;

/** Upgrade only legacy defaults; a custom binding conflict preserves the whole existing layout. */
export function migrateShortcutDefaults(
  settings: ShortcutSettings,
  platform: string,
  fromVersion = 0,
): ShortcutSettings {
  settings = withQuickChatShortcut(settings, platform);
  const primary = platform === "darwin" ? "Command" : "Control";
  const candidate = { ...settings, bindings: { ...settings.bindings } };
  const upgrades = [
    {
      version: 1,
      bindings: {
        "toggle-pane": ["K", "L"],
        "select-model": ["L", ";"],
        search: ["Shift+F", "K"],
      },
    },
    {
      version: 2,
      bindings: {
        "toggle-sidebar": ["J", "["],
        "toggle-pane": ["L", "]"],
        "select-model": [";", "L"],
      },
    },
  ] as const;
  for (const upgrade of upgrades) {
    if (fromVersion >= upgrade.version) continue;
    for (const [command, [previous, next]] of Object.entries(upgrade.bindings)) {
      const id = command as keyof ShortcutSettings["bindings"];
      const binding = candidate.bindings[id];
      if (
        binding !== null &&
        normalizeShortcut(binding, platform) === normalizeShortcut(`${primary}+${previous}`, platform)
      )
        candidate.bindings[id] = `${primary}+${next}`;
    }
    if (validateShortcuts(candidate, platform)) return settings;
  }
  const environment = defaultShortcuts(platform).bindings["configure-environment"];
  if (
    fromVersion < 2 &&
    candidate.bindings["configure-environment"] === null &&
    !Object.values(candidate.bindings).some(
      (binding) => binding !== null && normalizeShortcut(binding, platform) === environment,
    )
  )
    candidate.bindings["configure-environment"] = environment;
  return validateShortcuts(candidate, platform) ? settings : candidate;
}
