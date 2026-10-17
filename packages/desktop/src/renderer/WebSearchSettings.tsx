import { Eye, EyeOff } from "lucide-react";
import { useState } from "react";
import { ProviderLogo } from "./ProviderLogo.tsx";
import { unwrap, useStore } from "./store.ts";
import "./web-search-settings.css";

export function WebSearchSettings() {
  const settings = useStore((state) => state.settings?.webSearch);
  const globalEnabled = useStore((state) => state.settings?.capabilities.webSearch);
  const [apiKey, setApiKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const save = async (remove = false, enabled?: boolean) => {
    setSaving(true);
    setError("");
    setNotice("");
    const key = apiKey.trim();
    try {
      const next = unwrap(
        await window.zpi.saveWebSearch({
          provider: "deepseek",
          ...(enabled !== undefined ? { enabled } : {}),
          ...(remove ? { apiKey: "" } : key && enabled !== false ? { apiKey: key } : {}),
        }),
      );
      useStore.setState({ settings: next });
      if (enabled !== false) setApiKey("");
      setVisible(false);
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
      setError(key ? message.replaceAll(key, "[已隐藏]") : message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="web-search-settings">
      <p className="global-settings-note">
        「插件能力」中的联网搜索默认开启。配置 API Key
        并启用服务后，新对话首次发送时可使用网页搜索和网页读取；已有对话保留原有配置。
      </p>
      <div className="web-search-provider-panel">
        <form
          className="web-search-editor"
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <div className="web-search-heading">
            <ProviderLogo preset="deepseek" size={28} />
            <div className="web-search-heading-copy">
              <h2>DeepSeek</h2>
              <p>独立配置联网服务，不受当前对话模型服务商影响。</p>
            </div>
            <button
              type="button"
              className={`web-search-enable ${settings?.enabled ? "" : "primary"}`}
              disabled={
                saving ||
                !settings ||
                (!settings.enabled && (settings.credentialsLocked || (!settings.hasApiKey && !apiKey.trim())))
              }
              onClick={() => void save(false, !settings?.enabled)}
            >
              {settings?.enabled ? "停用" : "启用"}
            </button>
          </div>
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
          <label className="web-search-key-label" htmlFor="web-search-api-key">
            API Key
          </label>
          <div className="web-search-key-control">
            <input
              id="web-search-api-key"
              type={visible ? "text" : "password"}
              value={apiKey}
              autoComplete="new-password"
              spellCheck={false}
              autoCapitalize="none"
              disabled={saving || settings?.credentialsLocked}
              placeholder={
                settings?.credentialsLocked
                  ? "已保存的 API Key 尚未解锁"
                  : settings?.hasApiKey
                    ? "已配置，留空保留现有 API Key"
                    : "输入 DeepSeek API Key"
              }
              onChange={(event) => {
                setApiKey(event.target.value);
                setNotice("");
                setError("");
              }}
              aria-describedby="web-search-key-note"
            />
            <button
              type="button"
              className="web-search-key-visibility"
              aria-label={visible ? "隐藏 API Key" : "显示 API Key"}
              aria-pressed={visible}
              disabled={saving}
              onClick={() => setVisible((value) => !value)}
            >
              {visible ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
          <p id="web-search-key-note" className="web-search-note">
            {settings?.hasApiKey
              ? "已配置 API Key。输入新密钥可替换，留空保留现有密钥。"
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
          {removing ? (
            <div className="web-search-remove-confirm">
              <p>移除 API Key 后，联网工具将无法使用。</p>
              <div className="web-search-actions">
                <button type="button" disabled={saving} onClick={() => setRemoving(false)}>
                  取消
                </button>
                <button
                  type="button"
                  className="web-search-remove"
                  disabled={saving}
                  onClick={() => void save(true)}
                >
                  确认移除
                </button>
              </div>
            </div>
          ) : (
            <div className="web-search-actions">
              {settings?.hasApiKey && (
                <button
                  type="button"
                  className="web-search-remove"
                  disabled={saving}
                  onClick={() => setRemoving(true)}
                >
                  移除 API Key
                </button>
              )}
              <button
                type="submit"
                className="primary web-search-save"
                disabled={saving || settings?.credentialsLocked || !apiKey.trim()}
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
            <p className="web-search-note" role="status">
              {notice}
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
