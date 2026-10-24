// Layout and key search adapted from ZCode settings/ShortcutSettingsSection (Apache-2.0).
import * as Dialog from "@radix-ui/react-dialog";
import { Keyboard, Pencil, RotateCcw, Search, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ActionHint } from "zpi-ui";
import {
  defaultShortcuts,
  formatShortcut,
  type ShortcutCommand,
  type ShortcutSettings as ShortcutPreferences,
  shortcutCommands,
  shortcutFromEvent,
  shortcutLabelParts,
  validateShortcuts,
} from "../shared/shortcuts.ts";
import { SettingsHelp } from "./SettingsHelp.tsx";
import { ShortcutRecordingRequest } from "./shortcut-recording.ts";
import { matchesShortcutSearch, shortcutScopeLabels } from "./shortcut-settings-model.ts";
import { report, useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import { userErrorMessage } from "./user-error.ts";

type Capture = ShortcutCommand | "key-search";

export function ShortcutSettings() {
  const saved = useStore((state) => state.settings?.shortcuts);
  const platform = window.zpi.platform;
  const defaults = defaultShortcuts(platform);
  const [draft, setDraft] = useState<ShortcutPreferences>(() => saved ?? defaults);
  const [recording, setRecording] = useState<Capture>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [keySearch, setKeySearch] = useState<string | null>(null);
  const [recordError, setRecordError] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [capturePending, setCapturePending] = useState(false);
  const mounted = useRef(true);
  const captureRequest = useRef(new ShortcutRecordingRequest());
  const searchInput = useRef<HTMLInputElement>(null);
  const recordingButton = useRef<HTMLButtonElement>(null);
  const exclusive = Boolean(recording) || capturePending;
  const finishRecording = () => {
    captureRequest.current.cancel();
    setRecording(undefined);
    setCapturePending(false);
    setRecordError("");
    setPreview(null);
    void window.zpi
      .setShortcutCapture(false)
      .then(unwrap)
      .catch((error) => {
        if (mounted.current) setError(userErrorMessage(error));
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
  const beginRecording = async (command: Capture) => {
    setError("");
    setNotice("");
    setRecordError("");
    setPreview(null);
    if (recording === command) return;
    setRecording(undefined);
    setCapturePending(true);
    try {
      const current = await captureRequest.current.start(() =>
        window.zpi.setShortcutCapture(true).then(unwrap),
      );
      if (!mounted.current || !current) return;
      setCapturePending(false);
      setRecording(command);
    } catch (error) {
      if (mounted.current) {
        setCapturePending(false);
        setError(userErrorMessage(error));
      }
    }
  };
  useEffect(() => {
    if (!recording) return;
    // Move away from editable text before capturing a combination, including IME input.
    (recording === "key-search" ? searchInput.current : recordingButton.current)?.focus();
  }, [recording]);
  useEffect(() => {
    if (!exclusive) return;
    const keydown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.isComposing || event.keyCode === 229 || event.repeat) return;
      if (event.key === "Escape") {
        finishRecording();
        return;
      }
      if (!recording) return;
      if (recording === "key-search" && event.key === "Backspace") {
        setKeySearch(null);
        return;
      }
      if (["Control", "Meta", "Alt", "Shift"].includes(event.key)) {
        setRecordError("");
        setPreview(null);
        return;
      }
      const binding = shortcutFromEvent(
        event,
        platform,
        recording.startsWith("quick-chat") || recording === "key-search",
      );
      if (recording === "key-search") {
        if (!binding || (!event.metaKey && !event.ctrlKey && !event.altKey && !/^F\d+$/.test(binding)))
          return;
        setKeySearch(binding);
        finishRecording();
        return;
      }
      if (!binding) {
        setRecordError("请选择带有修饰键的有效组合。");
        return;
      }
      const next = { ...draft, bindings: { ...draft.bindings, [recording]: binding } };
      const invalid = validateShortcuts(next, platform);
      if (invalid) {
        setPreview(binding);
        setRecordError(invalid);
        return;
      }
      setDraft(next);
      finishRecording();
    };
    window.addEventListener("keydown", keydown, true);
    return () => window.removeEventListener("keydown", keydown, true);
  }, [exclusive, recording, draft, platform]);
  const validation = validateShortcuts(draft, platform);
  const changed = JSON.stringify(draft) !== JSON.stringify(saved ?? defaults);
  const customized = shortcutCommands.some(({ id }) => draft.bindings[id] !== defaults.bindings[id]);
  const save = async () => {
    if (validation || busy || exclusive) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const settings = unwrap(await window.zpi.updateShortcuts(draft));
      useStore.setState({ settings });
      setDraft(settings.shortcuts);
      setNotice("快捷键已保存。");
    } catch (error) {
      setError(userErrorMessage(error));
    } finally {
      setBusy(false);
    }
  };
  const visible = shortcutCommands.filter(({ id, label }) =>
    matchesShortcutSearch(label, draft.bindings[id], query, keySearch, platform),
  );
  return (
    <div className="shortcut-settings" data-shortcut-recording={exclusive}>
      <div className="shortcut-settings-heading">
        <div className="settings-heading-title">
          <h1>键盘快捷键</h1>
          <SettingsHelp
            label="快捷键"
            text="点击键位或编辑图标录入，Esc 取消。更改后点击保存；全局快捷键注册失败时保留原设置。"
          />
        </div>
        <label className="shortcut-enable">
          <span>启用快捷键</span>
          <span className="settings-switch">
            <input
              type="checkbox"
              role="switch"
              aria-label="启用快捷键"
              aria-checked={draft.enabled}
              checked={draft.enabled}
              disabled={busy || exclusive}
              onChange={(event) => {
                setDraft({ ...draft, enabled: event.target.checked });
                setNotice("");
              }}
            />
            <span aria-hidden="true" />
          </span>
        </label>
      </div>
      <div className="shortcut-search-bar">
        <div className="shortcut-search">
          <Search size={16} aria-hidden="true" />
          <input
            ref={searchInput}
            aria-label="搜索命令或快捷键"
            placeholder={recording === "key-search" ? "请按下组合键…" : "搜索命令或快捷键"}
            value={keySearch ? formatShortcut(keySearch, platform) : query}
            readOnly={recording === "key-search" || keySearch !== null}
            disabled={busy}
            data-key-filter={keySearch !== null}
            onChange={(event) => setQuery(event.target.value)}
            onBlur={(event) => {
              if (
                recording === "key-search" &&
                !(
                  event.relatedTarget instanceof Element &&
                  event.relatedTarget.closest(".shortcut-key-search")
                )
              )
                finishRecording();
            }}
          />
          {(query || keySearch) && (
            <button
              className="shortcut-search-clear"
              aria-label="清空搜索"
              title="清空搜索"
              disabled={busy || exclusive}
              onClick={() => {
                setQuery("");
                setKeySearch(null);
                searchInput.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          )}
          <ActionHint label="按组合键搜索（Esc 取消）" appearance="control">
            <button
              className="shortcut-key-search"
              aria-label="按组合键搜索"
              aria-pressed={recording === "key-search"}
              disabled={busy || capturePending}
              onClick={() =>
                recording === "key-search" ? finishRecording() : void beginRecording("key-search")
              }
            >
              <Keyboard size={16} />
            </button>
          </ActionHint>
        </div>
        <button
          className="shortcut-reset"
          disabled={busy || exclusive || !customized}
          onClick={() => setConfirmReset(true)}
        >
          <RotateCcw size={16} />
          全部恢复默认
        </button>
      </div>
      <div className="shortcut-table-scroll">
        <table className="shortcut-table" aria-label="快捷键绑定" data-disabled={!draft.enabled}>
          <thead>
            <tr className="shortcut-table-header">
              {["命令", "按键绑定", "作用域", "操作"].map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visible.map(({ id, label, scope }) => {
              const active = recording === id;
              const [scopeLabel, scopeHint] = shortcutScopeLabels[scope];
              return (
                <tr
                  className="shortcut-setting-row"
                  key={id}
                  data-shortcut-command={id}
                  data-customized={draft.bindings[id] !== defaults.bindings[id]}
                >
                  <td className="shortcut-command" title={label}>
                    {label}
                  </td>
                  <td className="shortcut-binding-cell">
                    <div className="shortcut-binding">
                      {active && <Keyboard size={16} aria-hidden="true" />}
                      <button
                        ref={active ? recordingButton : undefined}
                        className={`shortcut-recorder ${active ? "recording" : ""}`}
                        aria-label={`录入${label}快捷键`}
                        aria-pressed={active}
                        aria-invalid={active && Boolean(recordError)}
                        aria-describedby={active ? `shortcut-hint-${id}` : undefined}
                        disabled={busy || capturePending}
                        onClick={() => void beginRecording(id)}
                        onBlur={() => {
                          if (active) finishRecording();
                        }}
                      >
                        {active ? (
                          <kbd>{preview ? formatShortcut(preview, platform) : "请按快捷键…"}</kbd>
                        ) : (
                          shortcutLabelParts(draft.bindings[id], platform).map((part, index) => (
                            <kbd key={`${part}-${index}`}>{part}</kbd>
                          ))
                        )}
                      </button>
                      {!active && (
                        <ActionHint label={`编辑${label}快捷键`} appearance="control">
                          <button
                            className="shortcut-edit"
                            aria-label={`编辑${label}快捷键`}
                            disabled={busy || capturePending}
                            onClick={() => void beginRecording(id)}
                          >
                            <Pencil size={14} />
                          </button>
                        </ActionHint>
                      )}
                    </div>
                    {active && (
                      <span
                        id={`shortcut-hint-${id}`}
                        role={recordError ? "alert" : undefined}
                        className={recordError ? "shortcut-record-error" : "shortcut-record-hint"}
                      >
                        {recordError || "按下新组合，Esc 取消"}
                      </span>
                    )}
                  </td>
                  <td className="shortcut-scope" title={scopeHint}>
                    {scopeLabel}
                  </td>
                  <td>
                    <ActionHint label={`清除${label}绑定（保留命令）`} appearance="control">
                      <button
                        className="shortcut-clear"
                        aria-label={`清除${label}快捷键`}
                        disabled={busy || exclusive || draft.bindings[id] === null}
                        onClick={() => {
                          setDraft({ ...draft, bindings: { ...draft.bindings, [id]: null } });
                          setNotice("");
                          setError("");
                        }}
                      >
                        <Trash2 size={16} />
                      </button>
                    </ActionHint>
                  </td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <tr className="shortcut-empty">
                <td colSpan={4}>没有匹配的命令或快捷键</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="shortcut-settings-footer">
        <button
          className="primary"
          disabled={busy || exclusive || Boolean(validation) || !changed}
          onClick={() => void save()}
        >
          {busy ? "保存中…" : "保存快捷键"}
        </button>
      </div>
      {(error || validation) && (
        <div role="alert" className="model-config-error">
          {error || validation}
        </div>
      )}
      {notice && (
        <p role="status" className="shortcut-notice">
          {notice}
        </p>
      )}
      <Dialog.Root open={confirmReset} onOpenChange={setConfirmReset}>
        <Dialog.Portal>
          <Dialog.Overlay className="model-config-backdrop" />
          <Dialog.Content className="provider-delete-dialog shortcut-reset-dialog">
            <header>
              <Dialog.Title>全部恢复默认快捷键？</Dialog.Title>
              <Dialog.Description>
                所有自定义绑定将恢复为 ZPI 默认键位。启用状态保持不变，点击保存后生效。
              </Dialog.Description>
            </header>
            <footer>
              <Dialog.Close className="secondary">取消</Dialog.Close>
              <button
                className="primary"
                onClick={() => {
                  setDraft({ ...defaults, enabled: draft.enabled });
                  setError("");
                  setNotice("已恢复默认，保存后生效。");
                  setConfirmReset(false);
                }}
              >
                恢复默认
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
