import { useEffect, useRef, useState } from "react";
import {
  defaultShortcuts,
  formatShortcut,
  type ShortcutCommand,
  type ShortcutSettings as ShortcutPreferences,
  shortcutCommands,
  shortcutFromEvent,
  validateShortcuts,
} from "../shared/shortcuts.ts";
import { ShortcutRecordingRequest } from "./shortcut-recording.ts";
import { report, unwrap, useStore } from "./store.ts";

export function ShortcutSettings() {
  const saved = useStore((state) => state.settings?.shortcuts);
  const platform = window.zpi.platform;
  const [draft, setDraft] = useState<ShortcutPreferences>(() => saved ?? defaultShortcuts(platform));
  const [recording, setRecording] = useState<ShortcutCommand>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const mounted = useRef(true);
  const captureRequest = useRef(new ShortcutRecordingRequest());
  const finishRecording = () => {
    captureRequest.current.cancel();
    setRecording(undefined);
    void window.zpi
      .setShortcutCapture(false)
      .then(unwrap)
      .catch((error) => {
        if (mounted.current) setError(String(error));
        else report(error);
      });
  };
  useEffect(() => {
    mounted.current = true;
    window.addEventListener("blur", finishRecording);
    return () => {
      mounted.current = false;
      captureRequest.current.cancel();
      window.removeEventListener("blur", finishRecording);
      void window.zpi.setShortcutCapture(false).then(unwrap).catch(report);
    };
  }, []);
  const beginRecording = async (command: ShortcutCommand, button: HTMLButtonElement) => {
    setError("");
    setNotice("");
    try {
      const current = await captureRequest.current.start(() =>
        window.zpi.setShortcutCapture(true).then(unwrap),
      );
      if (!mounted.current || !current) return;
      setRecording(command);
      button.focus();
    } catch (error) {
      if (mounted.current) setError(String(error));
    }
  };
  const validation = validateShortcuts(draft, platform);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved ?? defaultShortcuts(platform));
  const save = async () => {
    if (validation || busy || recording) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const settings = unwrap(await window.zpi.updateShortcuts(draft));
      useStore.setState({ settings });
      setDraft(settings.shortcuts);
      setNotice("快捷键已保存。");
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="shortcut-settings" data-shortcut-recording={Boolean(recording)}>
      <div className="settings-group">
        <label className="settings-row">
          <span className="settings-row-copy">
            <strong>启用快捷键</strong>
            <small>控制下列应用命令和全局窗口快捷键；复制、粘贴、撤销与常规导航仍可使用。</small>
          </span>
          <input
            type="checkbox"
            aria-label="启用快捷键"
            checked={draft.enabled}
            disabled={busy || Boolean(recording)}
            onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })}
          />
        </label>
      </div>
      <p className="settings-help">
        点击快捷键后按下新组合，Esc
        取消录入。修改后点击保存。全局快捷键可能与其他应用或系统设置冲突；注册失败时会保留原设置。
      </p>
      <div className="settings-group">
        {shortcutCommands.map(({ id, label, scope }) => (
          <div className="settings-row shortcut-setting-row" key={id} data-shortcut-command={id}>
            <span className="settings-row-copy">
              <strong>{label}</strong>
              {scope === "global" && <small>全局：应用在后台时也可使用</small>}
            </span>
            <div className="shortcut-setting-actions">
              <button
                className={`shortcut-recorder ${recording === id ? "recording" : ""}`}
                aria-label={`录入${label}快捷键`}
                aria-pressed={recording === id}
                disabled={busy || Boolean(recording && recording !== id)}
                onClick={(event) => void beginRecording(id, event.currentTarget)}
                onBlur={() => {
                  if (recording === id) finishRecording();
                }}
                onKeyDownCapture={(event) => {
                  if (recording !== id) return;
                  event.preventDefault();
                  event.stopPropagation();
                  if (event.nativeEvent.isComposing || event.keyCode === 229 || event.repeat) return;
                  if (event.key === "Escape") {
                    finishRecording();
                    return;
                  }
                  if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) return;
                  const binding = shortcutFromEvent(event.nativeEvent, platform);
                  if (!binding) {
                    setError("请选择带有修饰键的有效组合。");
                    return;
                  }
                  setDraft({ ...draft, bindings: { ...draft.bindings, [id]: binding } });
                  setError("");
                  finishRecording();
                }}
              >
                {recording === id ? "请按快捷键…" : formatShortcut(draft.bindings[id], platform) || "未设置"}
              </button>
              <button
                className="secondary shortcut-clear"
                aria-label={`清除${label}快捷键`}
                disabled={busy || Boolean(recording) || draft.bindings[id] === null}
                onClick={() => {
                  setDraft({ ...draft, bindings: { ...draft.bindings, [id]: null } });
                  setNotice("");
                }}
              >
                清除
              </button>
            </div>
          </div>
        ))}
      </div>
      {(error || validation) && (
        <div role="alert" className="model-config-error">
          {error || validation}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      <div className="shortcut-settings-footer">
        <button
          className="secondary"
          disabled={busy || Boolean(recording)}
          onClick={() => {
            setDraft(defaultShortcuts(platform));
            setError("");
            setNotice("已恢复默认，保存后生效。");
          }}
        >
          恢复默认
        </button>
        <button
          className="primary"
          disabled={busy || Boolean(recording) || Boolean(validation) || !changed}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存快捷键"}
        </button>
      </div>
    </div>
  );
}
