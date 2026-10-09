import { ActionHint } from "ZPI-ui";
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
    const panel = element.closest(".right-pane-frame");
    let frame = 0,
      last = "",
      disposed = false;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        if (disposed) return;
        const rect = element.getBoundingClientRect();
        const clip = panel?.getBoundingClientRect();
        const left = Math.max(0, rect.left, clip ? clip.left + 1 : 0);
        const top = Math.max(0, rect.top, clip ? clip.top + 1 : 0);
        const right = Math.min(window.innerWidth, rect.right, clip ? clip.right - 1 : window.innerWidth);
        const bottom = Math.min(window.innerHeight, rect.bottom, clip ? clip.bottom - 1 : window.innerHeight);
        // Native child views cover DOM overlays, but unrelated menus need not hide the page.
        const hidden =
          document.querySelector('[role="dialog"], dialog[open], .settings-screen') !== null ||
          Array.from(document.querySelectorAll('[role="menu"], [role="listbox"]')).some((menu) => {
            const overlay = menu.getBoundingClientRect();
            return (
              overlay.width > 0 &&
              overlay.height > 0 &&
              overlay.left < rect.right &&
              overlay.right > rect.left &&
              overlay.top < rect.bottom &&
              overlay.bottom > rect.top
            );
          });
        const bounds =
          hidden || right - left < 1 || bottom - top < 1
            ? null
            : {
                x: left,
                y: top,
                width: right - left,
                height: bottom - top,
              };
        const serialized = JSON.stringify(bounds);
        if (serialized !== last) {
          last = serialized;
          paneTask(window.ZPI.browserBounds(state.id, bounds).then(unwrap));
        }
      });
    };
    const resize = new ResizeObserver(update);
    resize.observe(element);
    if (panel) resize.observe(panel);
    const overlay = new MutationObserver(update);
    overlay.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "hidden", "data-state"],
    });
    window.addEventListener("resize", update);
    update();
    return () => {
      disposed = true;
      resize.disconnect();
      overlay.disconnect();
      window.removeEventListener("resize", update);
      cancelAnimationFrame(frame);
      paneTask(window.ZPI.browserBounds(state.id, null).then(unwrap));
    };
  }, [state.id, state.url, visible]);
  const action = (name: "back" | "forward" | "reload" | "stop") =>
    paneTask(window.ZPI.browserAction(state.id, name).then(unwrap));
  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <ActionHint label="后退" appearance="control">
          <button aria-label="浏览器后退" disabled={!state.back} onClick={() => action("back")}>
            <ArrowLeft size={15} />
          </button>
        </ActionHint>
        <ActionHint label="前进" appearance="control">
          <button aria-label="浏览器前进" disabled={!state.forward} onClick={() => action("forward")}>
            <ArrowRight size={15} />
          </button>
        </ActionHint>
        <ActionHint label={state.loading ? "停止加载" : "刷新"} appearance="control">
          <button
            aria-label={state.loading ? "停止加载" : "刷新页面"}
            onClick={() => action(state.loading ? "stop" : "reload")}
          >
            {state.loading ? <X size={15} /> : <RotateCw size={15} />}
          </button>
        </ActionHint>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submittedAddress.current = address;
            paneTask(
              window.ZPI.browserAction(state.id, "navigate", address)
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
        <ActionHint label="在默认浏览器中打开" appearance="control">
          <button
            aria-label="在外部浏览器打开"
            disabled={!state.url}
            onClick={() => paneTask(window.ZPI.openExternal(state.url).then(unwrap))}
          >
            <ExternalLink size={14} />
          </button>
        </ActionHint>
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
