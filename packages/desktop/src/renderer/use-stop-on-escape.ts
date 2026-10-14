import { useEffect, useRef } from "react";
import { defaultShortcuts, shortcutForEvent } from "../shared/shortcuts.ts";
import { hasVisibleShortcutBlocker } from "./shortcut-context.ts";
import { useStore } from "./store.ts";

/** Escape runs after dismissal; custom stop keys run before editor/terminal handlers. */
export function useStopOnEscape(stop?: () => void) {
  const callback = useRef(stop);
  callback.current = stop;
  useEffect(() => {
    let composing = false;
    const blocked = new WeakSet<Event>();
    const begin = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const matches = (event: KeyboardEvent, includeRepeat = false) =>
      shortcutForEvent(
        {
          key: event.key,
          code: event.code,
          ctrlKey: event.ctrlKey,
          metaKey: event.metaKey,
          altKey: event.altKey,
          shiftKey: event.shiftKey,
          isComposing: event.isComposing,
          repeat: includeRepeat ? false : event.repeat,
        },
        window.zpi.platform,
        useStore.getState().settings?.shortcuts ?? defaultShortcuts(window.zpi.platform),
      ) === "stop-run";
    const capture = (event: KeyboardEvent) => {
      if (!matches(event, true)) return;
      if (
        event.defaultPrevented ||
        composing ||
        event.isComposing ||
        event.keyCode === 229 ||
        hasVisibleShortcutBlocker(
          'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], [data-conversation-selection-tooltip], .command-panel, .settings-screen',
        )
      ) {
        blocked.add(event);
        return;
      }
      // 自定义停止键必须先于编辑器消费；例如 Shift+Command+Enter 否则会插入换行。
      // 裸 Escape 仍交给局部取消/关闭逻辑先处理，避免关闭弹层时同时停止回复。
      if (event.key !== "Escape" && callback.current) {
        event.preventDefault();
        event.stopPropagation();
        if (!event.repeat) callback.current();
      }
    };
    const bubble = (event: KeyboardEvent) => {
      if (!matches(event) || event.repeat || event.defaultPrevented || blocked.has(event)) return;
      if (callback.current) {
        event.preventDefault();
        callback.current();
      }
    };
    document.addEventListener("compositionstart", begin, true);
    document.addEventListener("compositionend", end, true);
    document.addEventListener("keydown", capture, true);
    document.addEventListener("keydown", bubble);
    return () => {
      document.removeEventListener("compositionstart", begin, true);
      document.removeEventListener("compositionend", end, true);
      document.removeEventListener("keydown", capture, true);
      document.removeEventListener("keydown", bubble);
    };
  }, []);
}
