import * as Dialog from "@radix-ui/react-dialog";
import * as Menu from "@radix-ui/react-dropdown-menu";
import { Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { ActionHint } from "zpi-ui";
import { ProviderCredentialInput } from "./ProviderCredentialInput.tsx";
import { ProviderHeadingActions } from "./ProviderHeadingActions.tsx";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { useStore } from "./store.ts";
import { unwrap } from "./unwrap.ts";
import "./web-search-settings.css";

export function WebSearchSettings() {
  const settings = useStore((state) => state.settings?.webSearch);
  const globalEnabled = useStore((state) => state.settings?.capabilities.webSearch);
  // Only genuine input changes populate the replacement. A revealed saved key is separate and transient.
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState<{ settings: typeof settings; key: string }>();
  const [visible, setVisible] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const revealRevision = useRef(0);
  const revealIntent = useRef(false);
  const draftEditing = useRef(editing);
  draftEditing.current = editing;
  const keyInput = useRef<HTMLInputElement>(null);
  const shownKey =
    revealed?.settings === settings && !settings?.credentialsLocked ? revealed?.key : undefined;
  const masked = Boolean(settings?.hasApiKey && !editing && shownKey === undefined);
  const keyNote = settings?.credentialsLocked
    ? "保存的 API Key 尚未解锁，联网服务暂不可用。解锁系统密钥存储后重启应用。"
    : !settings?.hasApiKey
      ? "尚未配置可用的 API Key，联网服务不可用。"
      : !settings.enabled
        ? "DeepSeek 服务已停用，保存的 API Key 将保留。"
        : undefined;
  const trimmed = apiKey.trim();
  const replacement = trimmed && !/^[*•●]+$/u.test(trimmed) ? trimmed : "";
  const clearReveal = useCallback(() => {
    revealRevision.current++;
    revealIntent.current = false;
    setRevealed(undefined);
    setRevealing(false);
    setVisible(false);
  }, []);
  useEffect(() => {
    if (!draftEditing.current) keyInput.current?.blur();
    clearReveal();
    // Every new public settings snapshot invalidates an outstanding read, including same-length replacements.
    // An unrelated settings refresh must not discard a replacement the user is still typing.
  }, [settings, clearReveal]);
  useEffect(() => {
    const hide = () => {
      keyInput.current?.blur();
      clearReveal();
    };
    const visibility = () => {
      if (document.hidden) hide();
    };
    window.addEventListener("blur", hide);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      revealRevision.current++;
      window.removeEventListener("blur", hide);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [clearReveal]);
  const resetDraft = () => {
    keyInput.current?.blur();
    setApiKey("");
    setEditing(false);
    clearReveal();
  };
  const cancelEdit = () => {
    if (inFlight.current) return;
    resetDraft();
    setError("");
    setNotice("");
  };
  const toggleVisibility = async () => {
    if (inFlight.current || removing || settings?.credentialsLocked) return;
    if (revealIntent.current) {
      if (!editing) keyInput.current?.blur();
      clearReveal();
      return;
    }
    revealIntent.current = true;
    if (editing || !settings?.hasApiKey) {
      setVisible(true);
      return;
    }
    const revision = ++revealRevision.current;
    setVisible(true);
    setRevealing(true);
    setError("");
    try {
      const value = unwrap(await window.zpi.getWebSearchCredentials());
      if (revision !== revealRevision.current) return;
      setRevealed({ settings, key: value.apiKey });
      setRevealing(false);
    } catch {
      if (revision !== revealRevision.current) return;
      clearReveal();
      setError("无法读取已保存的 API Key，请解锁系统密钥存储后重试。");
    }
  };
  const save = async (remove = false, enabled?: boolean) => {
    if (
      inFlight.current ||
      !settings ||
      (settings.credentialsLocked && enabled !== false) ||
      (!remove && enabled === undefined && !replacement) ||
      (enabled === true && !settings.hasApiKey && !replacement)
    )
      return;
    inFlight.current = true;
    clearReveal();
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const next = unwrap(
        await window.zpi.saveWebSearch({
          provider: "deepseek",
          ...(enabled !== undefined ? { enabled } : {}),
          ...(remove ? { apiKey: "" } : replacement && enabled !== false ? { apiKey: replacement } : {}),
        }),
      );
      useStore.setState({ settings: next });
      if (enabled !== false) resetDraft();
      setRemoving(false);
      setNotice(
        remove
          ? "已移除 API Key。"
          : enabled === true
            ? "已启用 DeepSeek 联网服务。"
            : enabled === false
              ? "已停用 DeepSeek 联网服务。"
              : "已保存 API Key。",
      );
    } catch {
      setError("无法保存联网搜索设置，请重试。");
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };
  return (
    <div className="web-search-settings">
      <div className="resource-section-heading">
        <p>
          「插件能力」中的联网搜索默认开启。配置 API Key
          并启用服务后，新对话首次发送时可使用网页搜索和网页读取；已有对话保留原有配置。
        </p>
      </div>
      <div className="settings-layout model-provider-panel web-search-provider-panel">
        <nav className="provider-list" aria-label="联网搜索提供商">
          <div className="provider-nav-group">
            <h3>供应商</h3>
            <ActionHint appearance="control" label="DeepSeek" side="right">
              <button
                type="button"
                className="selected"
                aria-label="DeepSeek"
                aria-current="true"
                disabled={saving || removing}
              >
                <ProviderLogo preset="deepseek" size={16} />
                <span>DeepSeek</span>
                <i
                  className={`provider-status ${settings?.enabled ? "enabled" : "disabled"}`}
                  title={settings?.enabled ? "已启用" : "已关闭"}
                  aria-hidden="true"
                />
              </button>
            </ActionHint>
          </div>
        </nav>
        <form
          className="provider-editor"
          onSubmit={(event) => {
            event.preventDefault();
            if (!removing) void save();
          }}
        >
          <div className="provider-details">
            <header className="provider-detail-heading">
              <ProviderLogo preset="deepseek" size={20} />
              <h2>DeepSeek</h2>
              <ProviderHeadingActions
                name="DeepSeek 联网服务"
                enabled={settings?.enabled ?? false}
                disabled={saving || removing}
                switchDisabled={
                  saving ||
                  removing ||
                  !settings ||
                  (!settings.enabled && (settings.credentialsLocked || (!settings.hasApiKey && !replacement)))
                }
                onEnabledChange={(enabled) => void save(false, enabled)}
              >
                {settings?.hasApiKey && (
                  <Menu.Item
                    className="provider-action-item provider-action-delete"
                    onSelect={() => {
                      clearReveal();
                      setError("");
                      setRemoving(true);
                    }}
                  >
                    <Trash2 size={14} />
                    移除 API Key
                  </Menu.Item>
                )}
              </ProviderHeadingActions>
            </header>
            <div className="provider-connection-fields">
              <label htmlFor="web-search-api-key">
                <span>API Key</span>
                <ProviderCredentialInput
                  ref={keyInput}
                  id="web-search-api-key"
                  label="API Key"
                  visible={visible && !masked}
                  onToggleVisibility={() => void toggleVisibility()}
                  visibilityDisabled={saving || removing || settings?.credentialsLocked}
                  visibilityLabel={visible ? "隐藏 API Key" : "显示 API Key"}
                  visibilityPressed={visible}
                  value={editing ? apiKey : (shownKey ?? "*".repeat(settings?.apiKeyLength ?? 0))}
                  spellCheck={false}
                  autoCapitalize="none"
                  disabled={saving || removing || settings?.credentialsLocked}
                  placeholder={settings?.credentialsLocked ? "保存的凭据尚未解锁" : "输入 API Key"}
                  onFocus={() => {
                    if (inFlight.current || settings?.credentialsLocked || shownKey !== undefined) return;
                    clearReveal();
                    setEditing(true);
                  }}
                  onChange={(event) => {
                    if (masked || inFlight.current || settings?.credentialsLocked) return;
                    revealRevision.current++;
                    setRevealed(undefined);
                    setRevealing(false);
                    setEditing(true);
                    setApiKey(event.target.value);
                    setNotice("");
                    setError("");
                  }}
                  onBlur={() => {
                    if (editing && !apiKey.trim() && !inFlight.current) resetDraft();
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      event.stopPropagation();
                      cancelEdit();
                    }
                  }}
                  aria-describedby={keyNote ? "web-search-key-note" : undefined}
                  aria-busy={revealing}
                />
              </label>
            </div>
            {keyNote && (
              <p id="web-search-key-note" className="web-search-note" role="status">
                {keyNote}
              </p>
            )}
            {globalEnabled === false && (
              <p className="web-search-note">「插件能力」中的联网搜索已关闭，新对话不会使用联网工具。</p>
            )}
            {settings?.hasApiKey && settings.credentialsPersisted === false && (
              <p className="web-search-storage-note" role="status">
                系统加密存储不可用，API Key 仅保留在本次应用运行的内存中，重启后需重新输入。
              </p>
            )}
            <div className="provider-footer">
              {error && (
                <p className="run-error" role="alert">
                  {error}
                </p>
              )}
              {notice && (
                <p className="run-notice" role="status">
                  {notice}
                </p>
              )}
              <div className="modal-actions">
                {editing && (
                  <button type="button" className="secondary" disabled={saving} onClick={cancelEdit}>
                    取消编辑
                  </button>
                )}
                <button
                  type="submit"
                  className="primary"
                  disabled={saving || settings?.credentialsLocked || !replacement}
                >
                  {saving ? "保存中…" : "保存"}
                </button>
              </div>
            </div>
          </div>
        </form>
      </div>
      <Dialog.Root
        open={removing}
        onOpenChange={(open) => {
          if (!saving) setRemoving(open);
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="model-config-backdrop" />
          <Dialog.Content
            className="provider-delete-dialog"
            onOpenAutoFocus={(event) => {
              event.preventDefault();
              document.querySelector<HTMLButtonElement>(".provider-delete-dialog .primary")?.focus();
            }}
            onKeyDownCapture={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.stopPropagation();
                event.currentTarget.querySelector<HTMLButtonElement>(".primary")?.click();
              }
            }}
            onEscapeKeyDown={(event) => {
              if (saving) event.preventDefault();
            }}
          >
            <header>
              <Dialog.Title>移除 DeepSeek 联网服务的 API Key？</Dialog.Title>
              <Dialog.Description>移除后联网工具将无法使用，可重新配置 API Key。</Dialog.Description>
            </header>
            {error && (
              <div className="model-config-error" role="alert">
                {error}
              </div>
            )}
            <footer>
              <Dialog.Close className="secondary" disabled={saving}>
                取消<span aria-hidden="true">esc</span>
              </Dialog.Close>
              <button type="button" className="primary" disabled={saving} onClick={() => void save(true)}>
                确认移除
              </button>
            </footer>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  );
}
