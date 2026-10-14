import { type ShortcutSettings, shortcutForEvent } from "../shared/shortcuts.ts";
import { hasVisibleShortcutBlocker } from "./shortcut-context.ts";

export function composerShortcutCommand(
  event: KeyboardEvent,
  platform: string,
  settings: ShortcutSettings | undefined,
): "send-next" | "select-model" | "configure-environment" | undefined {
  if (!settings || event.defaultPrevented || event.isComposing || event.keyCode === 229) return;
  // Repeated shortcuts must still be consumed before the editor's own handlers;
  // ChatComposer suppresses dispatch for those events.
  const command = shortcutForEvent(
    {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      repeat: false,
    },
    platform,
    settings,
  );
  if (command !== "send-next" && command !== "select-model" && command !== "configure-environment") return;
  if (
    hasVisibleShortcutBlocker(
      'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .command-panel, .settings-screen, [data-shortcut-recording="true"]',
    )
  )
    return;
  return command;
}
