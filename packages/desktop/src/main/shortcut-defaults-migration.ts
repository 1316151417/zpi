import {
  defaultShortcuts,
  normalizeShortcut,
  type ShortcutSettings,
  validateShortcuts,
} from "../shared/shortcuts.ts";

export const shortcutDefaultsVersion = 1;

/** Upgrade only legacy defaults; a custom binding conflict preserves the whole existing layout. */
export function migrateShortcutDefaults(settings: ShortcutSettings, platform: string): ShortcutSettings {
  const primary = platform === "darwin" ? "Command" : "Control";
  const previous = {
    "toggle-pane": `${primary}+K`,
    "select-model": `${primary}+L`,
    search: `${primary}+Shift+F`,
  } as const;
  const defaults = defaultShortcuts(platform);
  const candidate = { ...settings, bindings: { ...settings.bindings } };
  for (const command of Object.keys(previous) as (keyof typeof previous)[]) {
    const binding = settings.bindings[command];
    if (
      binding !== null &&
      normalizeShortcut(binding, platform) === normalizeShortcut(previous[command], platform)
    )
      candidate.bindings[command] = defaults.bindings[command];
  }
  return validateShortcuts(candidate, platform) ? settings : candidate;
}
