import { Eye, EyeOff } from "lucide-react";
import { useRef, useState } from "react";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { unwrap, useStore } from "./store.ts";
import "./web-search-settings.css";

const savedKeyMask = "********";

export function WebSearchSettings() {
  const settings = useStore((state) => state.settings?.webSearch);
  const globalEnabled = useStore((state) => state.settings?.capabilities.webSearch);
  // This state contains only a replacement typed here, never the saved secret or its display mask.
  const [apiKey, setApiKey] = useState("");
  const [editing, setEditing] = useState(false);
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const inFlight = useRef(false);
  const keyInput = useRef<HTMLInputElement>(null);
  const stored = Boolean(settings?.hasApiKey || settings?.credentialsLocked);
  const masked = stored && !editing;
  const trimmed = apiKey.trim();
  const replacement = trimmed && !/^[*•●]+$/u.test(trimmed) ? trimmed : "";
  const resetDraft = () => {
    // Never leave the display mask editable after Escape or an Enter-key save.
    keyInput.current?.blur();
    setApiKey("");
    setEditing(false);
    setVisible(false);
  };
  const cancelEdit = () => {
    if (inFlight.current) return;
    resetDraft();
    setError("");
    setNotice("");
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
      else setVisible(false);
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
    } catch (error) {
      const message = String(error);
      setError(trimmed ? message.replaceAll(trimmed, "[已隐藏]") : message);
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
      <div className="model-provider-panel web-search-provider-panel">
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
              <div className="provider-heading-actions">
                <button
                  type="button"
                  className={`${settings?.enabled ? "secondary" : "primary"} web-search-enable`}
                  disabled={
                    saving ||
                    removing ||
                    !settings ||
                    (!settings.enabled &&
                      (settings.credentialsLocked || (!settings.hasApiKey && !replacement)))
                  }
                  onClick={() => void save(false, !settings?.enabled)}
                >
                  {settings?.enabled ? "停用" : "启用"}
                </button>
              </div>
            </header>
            <p className="web-search-note">独立配置联网服务，不受当前对话模型服务商影响。</p>
            <p className="web-search-note" role="status">
              {settings?.credentialsLocked
                ? "保存的 API Key 尚未解锁，联网服务暂不可用。解锁系统密钥存储后重启应用。"
                : !settings?.hasApiKey
                  ? "尚未配置 API Key，联网服务不可用。"
                  : settings.enabled
                    ? "DeepSeek 服务已启用。"
                    : "DeepSeek 服务已停用，保存的 API Key 将保留。"}
            </p>
            {globalEnabled === false && (
              <p className="web-search-note">「插件能力」中的联网搜索已关闭，新对话不会使用联网工具。</p>
            )}
            <div className="provider-connection-fields">
              <label htmlFor="web-search-api-key">
                <span>API Key</span>
                <span className="credential-input">
                  <input
                    ref={keyInput}
                    id="web-search-api-key"
                    aria-label="API Key"
                    type={masked || visible ? "text" : "password"}
                    value={masked ? savedKeyMask : apiKey}
                    autoComplete="off"
                    spellCheck={false}
                    autoCapitalize="none"
                    disabled={saving || removing || settings?.credentialsLocked}
                    placeholder="输入 API Key"
                    onFocus={() => {
                      if (inFlight.current || settings?.credentialsLocked) return;
                      setEditing(true);
                    }}
                    onChange={(event) => {
                      if (masked || inFlight.current || settings?.credentialsLocked) return;
                      setEditing(true);
                      setApiKey(event.target.value);
                      setNotice("");
                      setError("");
                    }}
                    onBlur={() => {
                      if (!apiKey.trim() && !inFlight.current) resetDraft();
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.preventDefault();
                        event.stopPropagation();
                        cancelEdit();
                      }
                    }}
                    aria-describedby="web-search-key-note"
                  />
                  <button
                    type="button"
                    aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
                    aria-pressed={visible}
                    disabled={saving || removing || masked || settings?.credentialsLocked}
                    onClick={() => setVisible((value) => !value)}
                  >
                    {visible ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </span>
              </label>
            </div>
            <p id="web-search-key-note" className="web-search-note">
              {stored
                ? "已保存的 API Key 仅显示固定掩码。输入新密钥可替换，留空保留现有密钥。"
                : "使用 DeepSeek 联网服务的 API Key。"}
            </p>
            {settings?.hasApiKey && settings.credentialsPersisted === false && (
              <p className="web-search-storage-note" role="status">
                系统加密存储不可用，API Key 仅保留在本次应用运行的内存中，重启后需重新输入。
              </p>
            )}
            <p className="web-search-note">
              搜索词或网页 URL 会发送给
              DeepSeek，返回的结果会发送给当前对话模型。不自动附带原始提问（ori_question）或用户 IP 参数。
            </p>
            <div className="provider-footer">
              {removing ? (
                <div className="web-search-remove-confirm">
                  <p className="web-search-note">移除 API Key 后，联网工具将无法使用。</p>
                  <div className="modal-actions">
                    <button
                      type="button"
                      className="secondary"
                      disabled={saving}
                      onClick={() => setRemoving(false)}
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      className="secondary web-search-remove"
                      disabled={saving}
                      onClick={() => void save(true)}
                    >
                      确认移除
                    </button>
                  </div>
                </div>
              ) : (
                <div className="modal-actions">
                  {settings?.hasApiKey && (
                    <button
                      type="button"
                      className="secondary web-search-remove"
                      disabled={saving || settings.credentialsLocked}
                      onClick={() => setRemoving(true)}
                    >
                      移除 API Key
                    </button>
                  )}
                  {editing && (
                    <button type="button" className="secondary" disabled={saving} onClick={cancelEdit}>
                      取消编辑
                    </button>
                  )}
                  <button
                    type="submit"
                    className="primary web-search-save"
                    disabled={saving || settings?.credentialsLocked || !replacement}
                  >
                    {saving ? "保存中…" : "保存"}
                  </button>
                </div>
              )}
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
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}
