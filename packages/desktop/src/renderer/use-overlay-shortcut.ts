import { useEffect, useRef } from "react";
import { type ShortcutCommand, shortcutForEvent } from "../shared/shortcuts.ts";
import { hasVisibleShortcutBlocker } from "./shortcut-context.ts";
import { useStore } from "./store.ts";

/** An open layer owns only its own shortcut, including keys from portalled submenus. */
export function useOverlayShortcut(command: ShortcutCommand, open: boolean, close: () => void) {
  const callback = useRef(close);
  callback.current = close;
  useEffect(() => {
    if (!open) return;
    let composing = false;
    const begin = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const keydown = (event: KeyboardEvent) => {
      const settings = useStore.getState().settings?.shortcuts;
      if (!settings || event.defaultPrevented || composing || event.isComposing || event.keyCode === 229)
        return;
      if (!(event.target instanceof Element) || !event.target.closest(`[data-shortcut-owner="${command}"]`))
        return;
      if (hasVisibleShortcutBlocker('.settings-screen, [data-shortcut-recording="true"]')) return;
      if (
        shortcutForEvent(
          {
            key: event.key,
            code: event.code,
            ctrlKey: event.ctrlKey,
            metaKey: event.metaKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            repeat: false,
          },
          window.zpi.platform,
          settings,
        ) !== command
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) callback.current();
    };
    window.addEventListener("keydown", keydown, true);
    window.addEventListener("compositionstart", begin, true);
    window.addEventListener("compositionend", end, true);
    return () => {
      window.removeEventListener("keydown", keydown, true);
      window.removeEventListener("compositionstart", begin, true);
      window.removeEventListener("compositionend", end, true);
    };
  }, [command, open]);
}
