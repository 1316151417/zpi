import { fetchProviderModels, getProviderPreset } from "ZPI-ai";
import { beginChatGPTLogin, type ChatGPTLogin, revokeChatGPTCredential } from "ZPI-ai/auth/openai-chatgpt";
import { randomUUID } from "node:crypto";
import { mergeDiscoveredModels } from "../shared/config.ts";
import type { ErrorLog } from "./error-log.ts";
import type { SettingsStore } from "./storage.ts";

export class ChatGPTAuth {
  private pending = new Map<string, { login: ChatGPTLogin; providerId?: string; completing: boolean }>();
  private settings: SettingsStore;
  private fetcher: typeof fetch;
  private errors?: ErrorLog;
  constructor(settings: SettingsStore, fetcher: typeof fetch = fetch, errors?: ErrorLog) {
    this.settings = settings;
    this.fetcher = fetcher;
    this.errors = errors;
  }
  async begin(providerId: string | null) {
    if (this.pending.size) throw new Error("busy: 已有 ChatGPT 登录正在进行");
    const credential = providerId ? this.settings.getChatGPTCredential(providerId) : undefined;
    // Reserve before opening the callback listener so simultaneous IPC requests cannot start two flows.
    const loginId = randomUUID();
    const reservation = {
      login: undefined as unknown as ChatGPTLogin,
      ...(providerId ? { providerId } : {}),
      completing: false,
    };
    this.pending.set(loginId, reservation);
    try {
      const login = await beginChatGPTLogin({
        hostId: this.settings.getChatGPTHostId(),
        credential,
        fetch: this.fetcher,
      });
      if (this.pending.get(loginId) !== reservation) {
        login.cancel();
        throw new Error("provider: 登录已取消");
      }
      reservation.login = login;
      void login.wait().catch(() => {
        if (!reservation.completing) this.pending.delete(loginId);
      });
      return { loginId, url: login.url };
    } catch (error) {
      this.pending.delete(loginId);
      throw error;
    }
  }
  async complete(loginId: string) {
    const attempt = this.attempt(loginId);
    if (attempt.completing) throw new Error("busy: 登录正在完成");
    attempt.completing = true;
    try {
      const credential = await attempt.login.wait();
      if (this.pending.get(loginId) !== attempt) throw new Error("provider: 登录已取消");
      const providerId = attempt.providerId ?? randomUUID();
      if (!attempt.providerId) {
        const preset = getProviderPreset("openai-chatgpt");
        if (!preset) throw new Error("configuration: 缺少 ChatGPT 提供商");
        this.settings.saveProvider({
          id: providerId,
          preset: preset.id,
          name: credential.email ? `${preset.name} · ${credential.email}` : preset.name,
          baseUrl: preset.baseUrl,
          models: [],
        });
      }
      this.settings.saveChatGPTCredential(providerId, credential);
      let warning: string | undefined;
      try {
        const discovered = await fetchProviderModels(
          {
            preset: "openai-chatgpt",
            apiKey: await this.settings.getRequestApiKey(providerId, this.fetcher),
          },
          this.fetcher,
        );
        warning = discovered.warning;
        const { apiKey: _key, ...saved } = this.settings.snapshot(providerId);
        this.settings.saveProvider({
          ...saved,
          models: mergeDiscoveredModels(saved.models, discovered.models),
        });
      } catch (error) {
        this.errors?.write("chatgpt.models", error, { providerId });
        warning = "ChatGPT 已登录，模型列表获取失败，请点击获取模型列表重试。";
      }
      return { settings: this.settings.get(), providerId, ...(warning ? { warning } : {}) };
    } finally {
      this.pending.delete(loginId);
    }
  }
  submit(loginId: string, url: string) {
    this.attempt(loginId).login.submitCallback(url);
  }
  cancel(loginId: string) {
    const attempt = this.pending.get(loginId);
    this.pending.delete(loginId);
    attempt?.login?.cancel();
  }
  async disconnect(providerId: string) {
    for (const [id, attempt] of this.pending) if (attempt.providerId === providerId) this.cancel(id);
    const credential = this.settings.getChatGPTCredential(providerId);
    // Invalidate local requests immediately, including refreshes already in flight.
    const value = this.settings.disconnectChatGPT(providerId);
    let warning: string | undefined;
    if (credential) {
      try {
        await revokeChatGPTCredential(credential, this.fetcher);
      } catch (error) {
        this.errors?.write("chatgpt.revoke", error, { providerId });
        warning = "已在本机退出，但无法确认远端撤销。可在 ChatGPT 设置中断开此应用。";
      }
    }
    return { settings: value, ...(warning ? { warning } : {}) };
  }
  close() {
    for (const id of this.pending.keys()) this.cancel(id);
  }
  private attempt(id: string) {
    const value = this.pending.get(id);
    if (!value?.login) throw new Error("not_found: ChatGPT 登录已过期或取消");
    return value;
  }
}
