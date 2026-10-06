import { useEffect, useRef, useState } from "react";
import type { ProviderRecord, PublicSettings } from "../shared/bridge.ts";
import { unwrap } from "./store.ts";

export function ChatGPTConnection({
  provider,
  onSettings,
  onBusy,
  onError,
  onNotice,
}: {
  provider?: ProviderRecord;
  onSettings: (settings: PublicSettings, providerId: string) => void;
  onBusy: (busy: boolean) => void;
  onError: (error: string) => void;
  onNotice: (notice: string) => void;
}) {
  const pending = useRef<string | undefined>(undefined);
  const mounted = useRef(true);
  const [login, setLogin] = useState<{ loginId: string; url: string }>();
  const [callback, setCallback] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(
    () => () => {
      mounted.current = false;
      if (pending.current) void window.ZPI.cancelChatGPTLogin(pending.current);
    },
    [],
  );
  const signIn = async () => {
    setBusy(true);
    onBusy(true);
    onError("");
    onNotice("");
    try {
      const attempt = unwrap(await window.ZPI.beginChatGPTLogin(provider?.id ?? null));
      if (!mounted.current) {
        void window.ZPI.cancelChatGPTLogin(attempt.loginId);
        return;
      }
      pending.current = attempt.loginId;
      setLogin(attempt);
      const result = unwrap(await window.ZPI.completeChatGPTLogin(attempt.loginId));
      if (!mounted.current || pending.current !== attempt.loginId) return;
      pending.current = undefined;
      setLogin(undefined);
      setCallback("");
      onSettings(result.settings, result.providerId);
      onNotice(result.warning ?? "ChatGPT 已登录，模型列表已自动获取。");
    } catch (error) {
      if (mounted.current && pending.current !== "cancelled") onError(String(error));
    } finally {
      if (mounted.current) {
        pending.current = undefined;
        setLogin(undefined);
        setBusy(false);
        onBusy(false);
      }
    }
  };
  const cancel = () => {
    const id = pending.current;
    pending.current = "cancelled";
    if (id) void window.ZPI.cancelChatGPTLogin(id);
  };
  const disconnect = async () => {
    if (!provider) return;
    setBusy(true);
    onBusy(true);
    onError("");
    try {
      const result = unwrap(await window.ZPI.disconnectChatGPT(provider.id));
      if (mounted.current) {
        onSettings(result.settings, provider.id);
        onNotice(result.warning ?? "已退出 ChatGPT。");
      }
    } catch (error) {
      if (mounted.current) onError(String(error));
    } finally {
      if (mounted.current) {
        setBusy(false);
        onBusy(false);
      }
    }
  };
  return (
    <section className="chatgpt-connection" aria-label="ChatGPT 授权">
      <p>
        {provider?.chatgptAccount?.connected
          ? `已登录：${provider.chatgptAccount.label}`
          : "登录 ChatGPT 并授权使用套餐。登录后自动获取账号可用模型。"}
      </p>
      <div className="chatgpt-actions">
        <button className="primary" disabled={busy} onClick={() => void signIn()}>
          {provider?.chatgptAccount?.connected ? "重新登录 ChatGPT" : "Continue with ChatGPT"}
        </button>
        {provider?.chatgptAccount?.connected && (
          <button disabled={busy} onClick={() => void disconnect()}>
            退出登录
          </button>
        )}
      </div>
      {login && (
        <div className="chatgpt-login-pending">
          <p role="status">正在等待浏览器完成授权…</p>
          <button onClick={() => void window.ZPI.openExternal(login.url)}>重新打开登录页面</button>
          <button onClick={cancel}>取消登录</button>
          <label>
            回调地址（浏览器未能自动返回时）
            <input
              aria-label="ChatGPT 回调地址"
              value={callback}
              onChange={(event) => setCallback(event.target.value)}
              placeholder="http://127.0.0.1:…/auth/callback?…"
            />
          </label>
          <button
            disabled={!callback.trim()}
            onClick={() => {
              void window.ZPI.submitChatGPTCallback(login.loginId, callback)
                .then(unwrap)
                .then(() => setCallback(""))
                .catch((error) => onError(String(error)));
            }}
          >
            提交回调地址
          </button>
        </div>
      )}
    </section>
  );
}
