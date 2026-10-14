import type { SessionRecord } from "../shared/bridge.ts";
import { formatShortcut, type ShortcutCommand, type ShortcutSettings } from "../shared/shortcuts.ts";
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

/** Use the same displayed index as pin command dispatch; never invent an unbound shortcut. */
export function pinnedTaskShortcut(index: number, settings: ShortcutSettings, platform: string): string {
  const commands = ["pin-1", "pin-2", "pin-3", "pin-4", "pin-5"] as const;
  const command = commands[index];
  const binding = command && settings.enabled ? settings.bindings[command] : null;
  return binding ? formatShortcut(binding, platform) : "";
}

/** Observe without consuming input, including keyup events consumed by editors. */
export function listenShortcutModifier(platform: string, onChange: (held: boolean) => void): () => void {
  const update = (event: KeyboardEvent) => onChange(platform === "darwin" ? event.metaKey : event.ctrlKey);
  const reset = () => onChange(false);
  window.addEventListener("keydown", update, { capture: true });
  window.addEventListener("keyup", update, { capture: true });
  window.addEventListener("blur", reset);
  document.addEventListener("visibilitychange", reset);
  return () => {
    window.removeEventListener("keydown", update, { capture: true });
    window.removeEventListener("keyup", update, { capture: true });
    window.removeEventListener("blur", reset);
    document.removeEventListener("visibilitychange", reset);
  };
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
