import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionHint } from "zpi-ui";
import type { BrowserState } from "../shared/bridge.ts";
import { browserAddressAfterNavigation } from "./browser-address.ts";
import { paneTask } from "./pane-store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./browser-pane.css";
export function BrowserPane({ state, visible }: { state: BrowserState; visible: boolean }) {
  const root = useRef<HTMLDivElement>(null),
    [address, setAddress] = useState(state.url);
  const submittedAddress = useRef<string | null>(null);
  const previousUrl = useRef(state.url);
  const editingAddress = useRef(false);
  const hasUrl = Boolean(state.url);
  useEffect(() => {
    const changed = previousUrl.current !== state.url;
    previousUrl.current = state.url;
    if (submittedAddress.current === null) {
      if (changed)
        setAddress((current) =>
          browserAddressAfterNavigation(current, state.url, null, editingAddress.current),
        );
      return;
    }
    if (state.loading) return;
    const submitted = submittedAddress.current;
    submittedAddress.current = null;
    // Reloading the same URL still needs to canonicalize the submitted address.
    // Keep text entered after submission while navigation was in progress.
    setAddress((current) => browserAddressAfterNavigation(current, state.url, submitted));
  }, [state]);
  useEffect(() => {
    const element = root.current;
    if (!element || !visible || !hasUrl) return;
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
          paneTask(window.zpi.browserBounds(state.id, bounds).then(unwrap));
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
      paneTask(window.zpi.browserBounds(state.id, null).then(unwrap));
    };
  }, [state.id, hasUrl, visible]);
  const action = (name: "back" | "forward" | "reload") =>
    paneTask(window.zpi.browserAction(state.id, name).then(unwrap));
  return (
    <div className="browser-pane">
      <div className="browser-toolbar">
        <ActionHint label="后退" appearance="control">
          <button aria-label="浏览器后退" disabled={!state.back} onClick={() => action("back")}>
            <ChevronLeft size={16} />
          </button>
        </ActionHint>
        <ActionHint label="前进" appearance="control">
          <button aria-label="浏览器前进" disabled={!state.forward} onClick={() => action("forward")}>
            <ChevronRight size={16} />
          </button>
        </ActionHint>
        <ActionHint label="刷新" appearance="control">
          <button
            aria-label="刷新页面"
            disabled={!state.url && !state.loading}
            onClick={() => action("reload")}
          >
            <RefreshCw size={16} className={state.loading ? "browser-refresh-spinning" : undefined} />
          </button>
        </ActionHint>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            submittedAddress.current = address;
            editingAddress.current = false;
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
            type="text"
            placeholder="输入网址后回车"
            spellCheck={false}
            autoComplete="off"
            autoCapitalize="off"
            value={address}
            onChange={(event) => {
              editingAddress.current = true;
              setAddress(event.target.value);
            }}
            onBlur={() => {
              editingAddress.current = false;
            }}
          />
        </form>
        <ActionHint label="在默认浏览器中打开" appearance="control">
          <button
            aria-label="在外部浏览器打开"
            disabled={!state.url}
            onClick={() => paneTask(window.zpi.openExternal(state.url).then(unwrap))}
          >
            <ExternalLink size={16} />
          </button>
        </ActionHint>
      </div>
      {state.error && (
        <p className="run-error" role="alert">
          {userErrorMessage(state.error)}
        </p>
      )}
      <div ref={root} className="browser-surface" data-testid="browser-surface" />
    </div>
  );
}
