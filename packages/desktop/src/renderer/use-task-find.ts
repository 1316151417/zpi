import { useCallback, useEffect, useRef, useState } from "react";
import type { FindRequest, FindState } from "zpi-ui";
import { openChanges, usePane } from "./pane-store.ts";

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
  const show = useCallback(() => {
    if (!enabled || !sessionId) return;
    if (!open) opener.current = document.activeElement;
    setOpen(true);
    setFocusRequestId((id) => id + 1);
  }, [enabled, sessionId, open]);
  useEffect(() => {
    let composing = false;
    const begin = () => {
      composing = true;
    };
    const end = () => {
      composing = false;
    };
    const keydown = (event: KeyboardEvent) => {
      if (composing || event.isComposing || event.keyCode === 229) return;
      if (open && event.key === "Escape" && !event.defaultPrevented) {
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
  }, [open, close]);
  const start = useCallback(
    (query: string, targetRunId?: string, matchBefore?: string, matchAfter?: string) => {
      opener.current = document.querySelector('[aria-label="消息"]') ?? document.activeElement;
      setScope("conversation");
      setOpen(true);
      setRequest((current) => ({
        query,
        targetRunId,
        matchBefore,
        matchAfter,
        activeIndex: query.trim() ? 0 : -1,
        navigationId: current.navigationId + 1,
      }));
      setState(emptyState());
      setFocusRequestId((id) => id + 1);
    },
    [],
  );
  const change = useCallback((query: string) => {
    setRequest((current) => ({
      ...current,
      targetRunId: undefined,
      matchBefore: undefined,
      matchAfter: undefined,
      query,
      activeIndex: query.trim() ? 0 : -1,
    }));
    setState(emptyState());
  }, []);
  const navigate = useCallback((activeIndex: number) => {
    setRequest((current) => ({
      ...current,
      targetRunId: undefined,
      matchBefore: undefined,
      matchAfter: undefined,
      activeIndex,
      navigationId: current.navigationId + 1,
    }));
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
      targetRunId: undefined,
      matchBefore: undefined,
      matchAfter: undefined,
      activeIndex: current.query.trim() ? 0 : -1,
      navigationId: current.navigationId + 1,
    }));
    setState(emptyState());
    if (next === "changes" && sessionId) {
      const pane = usePane.getState();
      const active = pane.tabs.find((tab) => tab.id === pane.active);
      if (active?.type !== "changes" || !active.reviewSource) openChanges(sessionId, null);
    }
    setFocusRequestId((id) => id + 1);
  }, [scope, sessionId]);
  return {
    start,
    show,
    open,
    scope,
    request,
    state,
    focusRequestId,
    change,
    navigate,
    update,
    toggleScope,
    close,
  };
}
