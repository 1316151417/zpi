import type { SessionRecord } from "../shared/bridge.ts";
import {
  type ShortcutCommand,
  type ShortcutKeyEvent,
  type ShortcutSettings,
  shortcutForEvent,
} from "../shared/shortcuts.ts";

export function visiblePinnedTasks(records: readonly SessionRecord[]): SessionRecord[] {
  return records
    .filter(
      (record) =>
        !record.draft && !record.parentSessionId && record.archivedAt == null && record.pinnedAt != null,
    )
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
}

export function isWorkspaceShortcut(command: ShortcutCommand): boolean {
  return (
    ["toggle-sidebar", "toggle-pane", "new-task", "search", "find"].includes(command) ||
    command.startsWith("pin-")
  );
}

/** Match held keys as well, so they are consumed without repeated dispatch or terminal input. */
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

export function workspaceShortcutBlocked(command: ShortcutCommand): boolean {
  const dialogs = command === "find" ? '[role="dialog"]:not(.task-find-bar)' : '[role="dialog"]';
  return Boolean(
    document.querySelector(
      `dialog[open], ${dialogs}, [role="alertdialog"], [role="menu"], [role="listbox"], .command-panel, .settings-screen, [data-shortcut-recording="true"]`,
    ),
  );
}
