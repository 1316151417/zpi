import {
  type ShortcutCommand,
  type ShortcutKeyEvent,
  type ShortcutSettings,
  shortcutForEvent,
} from "./shortcuts.ts";

export function isWorkspaceShortcut(command: ShortcutCommand): boolean {
  return (
    ["toggle-sidebar", "toggle-pane", "focus-composer", "new-task", "search", "find"].includes(command) ||
    command.startsWith("pin-")
  );
}

/** Match held keys too, so native guests and terminals consume them without repeating the action. */
export function workspaceShortcutForEvent(
  event: ShortcutKeyEvent,
  platform: string,
  settings: ShortcutSettings,
) {
  const command = shortcutForEvent(
    {
      key: event.key,
      code: event.code,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.isComposing,
      repeat: false,
    },
    platform,
    settings,
  );
  return command && isWorkspaceShortcut(command) ? command : undefined;
}
