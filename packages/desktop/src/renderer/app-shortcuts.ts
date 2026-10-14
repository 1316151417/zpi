import type { SessionRecord } from "../shared/bridge.ts";
import type { ShortcutCommand, ShortcutSettings } from "../shared/shortcuts.ts";
import { workspaceShortcutForEvent } from "../shared/workspace-shortcuts.ts";

export { isWorkspaceShortcut, workspaceShortcutForEvent } from "../shared/workspace-shortcuts.ts";

import { hasVisibleShortcutBlocker } from "./shortcut-context.ts";

export function visiblePinnedTasks(records: readonly SessionRecord[]): SessionRecord[] {
  return records
    .filter(
      (record) =>
        !record.draft && !record.parentSessionId && record.archivedAt == null && record.pinnedAt != null,
    )
    .sort((a, b) => (a.pinnedAt ?? 0) - (b.pinnedAt ?? 0));
}

export function workspaceShortcutBlocked(command: ShortcutCommand): boolean {
  const dialogs = command === "find" ? '[role="dialog"]:not(.task-find-bar)' : '[role="dialog"]';
  return hasVisibleShortcutBlocker(
    `dialog[open], ${dialogs}, [role="alertdialog"], [role="menu"], [role="listbox"], .command-panel, .settings-screen, [data-shortcut-recording="true"]`,
  );
}

/** Capture before contentEditable formatting or xterm's Ctrl+I / Tab handling. */
export function captureWorkspaceShortcut(
  event: KeyboardEvent,
  platform: string,
  settings: ShortcutSettings,
  run: (command: ShortcutCommand) => void,
  composing = false,
): void {
  if (event.defaultPrevented || composing || event.isComposing || event.keyCode === 229) return;
  const command = workspaceShortcutForEvent(event, platform, settings);
  if (!command || workspaceShortcutBlocked(command)) return;
  event.preventDefault();
  event.stopPropagation();
  if (!event.repeat) run(command);
}
