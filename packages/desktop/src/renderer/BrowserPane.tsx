import { ArrowLeft, ArrowRight, ExternalLink, RotateCw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { BrowserState } from "../shared/bridge.ts";
import { paneTask } from "./pane-store.ts";
import { unwrap } from "./store.ts";
export function BrowserPane({ state, visible }: { state: BrowserState; visible: boolean }) {
  const root = useRef<HTMLDivElement>(null),
    [address, setAddress] = useState(state.url);
  const submittedAddress = useRef<string | null>(null);
  const previousUrl = useRef(state.url);
  useEffect(() => {
    const changed = previousUrl.current !== state.url;
    previousUrl.current = state.url;
    if (submittedAddress.current === null) {
      if (changed) setAddress(state.url);
      return;
    }
    if (state.loading) return;
    const submitted = submittedAddress.current;
    submittedAddress.current = null;
    // Reloading the same URL still needs to canonicalize the submitted address.
    // Keep text entered after submission while navigation was in progress.
    setAddress((current) => (current === submitted ? state.url : current));
  }, [state]);
  useEffect(() => {
    const element = root.current;
    if (!element || !visible || !state.url) return;
    let frame = 0,
      last = "",
      disposed = false;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const hidden =
          document.querySelector(
            '[role="dialog"], dialog[open], [role="menu"], [role="listbox"], .settings-screen',
          ) !== null;
        const rect = element.getBoundingClientRect();
        const bounds =
          hidden || rect.width < 1 || rect.height < 1
            ? null
            : {
                x: Math.max(0, rect.x),
                y: Math.max(0, rect.y),
                width: Math.min(rect.width, window.innerWidth - rect.x),
                height: Math.min(rect.height, window.innerHeight - rect.y),
              };
        const serialized = JSON.stringify(bounds);
        if (serialized !== last) {
          last = serialized;
          paneTask(window.zpi.browserBounds(state.id, bounds).then(unwrap));
        }
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    const overlay = new MutationObserver(update);
    overlay.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("resize", update);
    update();
    return () => {
      disposed = true;
      resize.disconnect();
      overlay.disconnect();
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
      paneTask(window.zpi.browserBounds(state.id, null).then(unwrap));
    };
  }, [state.id, state.url, visible]);
  const action = (name: "back" | "forward" | "reload" | "stop") =>
    paneTask(window.zpi.browserAction(state.id, name).then(unwrap));
  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <button aria-label="浏览器后退" title="后退" disabled={!state.back} onClick={() => action("back")}>
          <ArrowLeft size={15} />
        </button>
        <button
          aria-label="浏览器前进"
          title="前进"
          disabled={!state.forward}
          onClick={() => action("forward")}
        >
          <ArrowRight size={15} />
        </button>
        <button
          aria-label={state.loading ? "停止加载" : "刷新页面"}
          onClick={() => action(state.loading ? "stop" : "reload")}
        >
          {state.loading ? <X size={15} /> : <RotateCw size={15} />}
        </button>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submittedAddress.current = address;
            paneTask(
              window.zpi
                .browserAction(state.id, "navigate", address)
                .then(unwrap)
                .catch((error) => {
                  submittedAddress.current = null;
                  throw error;
                }),
            );
          }}
        >
          <input
            aria-label="浏览器地址"
            placeholder="输入网址或本地文件路径"
            value={address}
            onChange={(event) => setAddress(event.target.value)}
          />
        </form>
        <button
          aria-label="在外部浏览器打开"
          title="在外部浏览器打开"
          disabled={!state.url}
          onClick={() => paneTask(window.zpi.openExternal(state.url).then(unwrap))}
        >
          <ExternalLink size={14} />
        </button>
      </div>
      {state.error && (
        <p className="run-error" role="alert">
          {state.error}
        </p>
      )}
      <div ref={root} className="browser-surface" data-testid="browser-surface">
        {!state.url && <div className="pane-empty">输入地址，或点击聊天中的链接</div>}
      </div>
    </div>
  );
}
