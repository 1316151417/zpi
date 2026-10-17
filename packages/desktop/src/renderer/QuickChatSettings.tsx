import { useRef, useState } from "react";
import { defaultShortcuts, formatShortcut } from "../shared/shortcuts.ts";
import { unwrap, useStore } from "./store.ts";

export function QuickChatSettings({ onEditShortcut }: { onEditShortcut: () => void }) {
  const shortcuts = useStore((state) => state.settings?.shortcuts) ?? defaultShortcuts(window.zpi.platform);
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const open = async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setOpening(true);
    setError("");
    try {
      unwrap(await window.zpi.openQuickChat());
    } catch (error) {
      setError(String(error));
    } finally {
      inFlight.current = false;
      setOpening(false);
    }
  };
  return (
    <section aria-label="快速对话设置">
      <p className="settings-intro">临时对话，不保存到任务列表</p>
      <div className="settings-group">
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>全局快捷键</strong>
            <small>
              {formatShortcut(shortcuts.bindings["quick-chat"], window.zpi.platform)}
              {!shortcuts.enabled && "（快捷键已停用）"}
            </small>
          </span>
          <button type="button" onClick={onEditShortcut}>
            修改快捷键
          </button>
        </div>
        <div className="settings-row">
          <span className="settings-row-copy">
            <strong>快速对话</strong>
          </span>
          <button type="button" className="primary" disabled={opening} onClick={() => void open()}>
            {opening ? "打开中…" : "打开快速对话"}
          </button>
        </div>
      </div>
      {error && (
        <p role="alert" className="run-error">
          {error}
        </p>
      )}
    </section>
  );
}
