import { ActionHint } from "@zpi-dev/ui";
import { ChevronLeft, ChevronRight, ExternalLink, RefreshCw } from "lucide-react";
import { createElement, useCallback, useEffect, useRef, useState } from "react";
import type { BrowserState } from "../shared/bridge.ts";
import { browserAddressAfterNavigation } from "./browser-address.ts";
import { paneTask } from "./pane-store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";
import "./browser-pane.css";
export function BrowserPane({ state, visible }: { state: BrowserState; visible: boolean }) {
  const [address, setAddress] = useState(state.url);
  const [guestId, setGuestId] = useState(0);
  const webviewRef = useCallback((element: Electron.WebviewTag | null) => {
    if (!element) return;
    const ready = () => setGuestId(element.getWebContentsId());
    // 在 ref 提交时监听，避免快速加载的 about:blank 在 effect 执行前发出 dom-ready。
    element.addEventListener("dom-ready", ready);
    return () => element.removeEventListener("dom-ready", ready);
  }, []);
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
    if (!guestId) return;
    // 切换标签只更新可见状态；保留同一个 webview 和固定 src，避免重建或重复加载。
    paneTask(window.zpi.browserGuest(state.id, guestId, visible).then(unwrap));
  }, [state.id, guestId, visible]);
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
      <div className="browser-surface" data-testid="browser-surface">
        {hasUrl &&
          createElement("webview", {
            ref: webviewRef,
            src: "about:blank",
            partition: "persist:zpi-browser",
            allowpopups: "",
            className: "browser-webview",
          })}
      </div>
    </div>
  );
}
