import { useEffect, useRef } from "react";

/** Snapshot dismissible UI before its Escape handlers remove it. Stop runs last. */
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
    const capture = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (
        composing ||
        event.isComposing ||
        event.keyCode === 229 ||
        document.querySelector(
          'dialog[open], [role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"], .command-panel, .settings-screen',
        )
      )
        blocked.add(event);
    };
    const bubble = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.repeat || event.defaultPrevented || blocked.has(event)) return;
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
