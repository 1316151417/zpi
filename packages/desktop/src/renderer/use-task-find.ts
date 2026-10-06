import type { FindRequest, FindState } from "ZPI-ui";
import { useCallback, useEffect, useRef, useState } from "react";
import { openChanges } from "./pane-store.ts";

const emptyRequest = (): FindRequest => ({ query: "", activeIndex: -1, navigationId: 0 });
const emptyState = (): FindState => ({ total: 0, activeIndex: -1 });
export function useTaskFind(sessionId: string | undefined, enabled: boolean) {
  const [open, setOpen] = useState(false);
  const [scope, setScope] = useState<"conversation" | "changes">("conversation");
  const [request, setRequest] = useState(emptyRequest);
  const [state, setState] = useState(emptyState);
  const [focusRequestId, setFocusRequestId] = useState(0);
  const opener = useRef<Element | null>(null);
  const close = useCallback(() => {
    setOpen(false);
    setScope("conversation");
    setRequest(emptyRequest());
    setState(emptyState());
    if (opener.current instanceof HTMLElement && opener.current.isConnected) opener.current.focus();
    opener.current = null;
  }, []);
  useEffect(close, [sessionId, enabled, close]);
  useEffect(() => {
    let composing = false;
    const begin = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (composing || event.isComposing || event.keyCode === 229 || !enabled || !sessionId) return;
      if (
        (event.ctrlKey || event.metaKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "f"
      ) {
        if (document.querySelector('[role="dialog"]:not(.task-find-bar),[role="alertdialog"],[role="menu"]'))
          return;
        event.preventDefault();
        if (!open) opener.current = document.activeElement;
        setOpen(true);
        setFocusRequestId((id) => id + 1);
      } else if (open && event.key === "Escape" && !event.defaultPrevented) {
        event.preventDefault();
        close();
      }
    };
    window.addEventListener("compositionstart", begin);
    window.addEventListener("compositionend", end);
    window.addEventListener("keydown", keydown);
    return () => {
      window.removeEventListener("compositionstart", begin);
      window.removeEventListener("compositionend", end);
      window.removeEventListener("keydown", keydown);
    };
  }, [enabled, sessionId, open, close]);
  const change = useCallback((query: string) => {
    setRequest((current) => ({ ...current, query, activeIndex: query.trim() ? 0 : -1 }));
    setState(emptyState());
  }, []);
  const navigate = useCallback((activeIndex: number) => {
    setRequest((current) => ({ ...current, activeIndex, navigationId: current.navigationId + 1 }));
  }, []);
  const update = useCallback((next: FindState) => {
    setState((current) =>
      current.total === next.total && current.activeIndex === next.activeIndex ? current : next,
    );
    setRequest((current) =>
      current.activeIndex === next.activeIndex ? current : { ...current, activeIndex: next.activeIndex },
    );
  }, []);
  const toggleScope = useCallback(() => {
    const next = scope === "conversation" ? "changes" : "conversation";
    setScope(next);
    setRequest((current) => ({
      ...current,
      activeIndex: current.query.trim() ? 0 : -1,
      navigationId: current.navigationId + 1,
    }));
    setState(emptyState());
    if (next === "changes" && sessionId) openChanges(sessionId, null);
    setFocusRequestId((id) => id + 1);
  }, [scope, sessionId]);
  return { open, scope, request, state, focusRequestId, change, navigate, update, toggleScope, close };
}
