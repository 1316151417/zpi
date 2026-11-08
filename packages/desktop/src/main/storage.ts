import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { Model } from "zpi-ai";
import {
  anthropicMessagesCompatKeys,
  assertSupportedOptions,
  canControlThinking,
  discoverProviderCredentials,
  getProviderPreset,
  isJsonObject,
  openAICompletionsCompatKeys,
  presetModels,
  providerApi,
  providerApis,
  providerBaseUrl,
  usesChatGPTAuth,
  validateReasoningConfig,
  validateThinkingMap,
} from "zpi-ai";
import {
  type ChatGPTCredential,
  isChatGPTCredential,
  refreshChatGPTCredential,
  verifyRefreshedChatGPTCredential,
} from "zpi-ai/auth/openai-chatgpt";
import {
  builtinPluginCatalog,
  defaultPluginSettings,
  desktopPluginIds,
  validateBuiltinPluginOptions,
} from "zpi-builtin-plugins";
import {
  defaultMemorySettings,
  type MemorySettings,
  memorySettingLimits,
} from "zpi-builtin-plugins/memory/types";
import { type PromptTemplate, piTemplate, validateTemplate } from "zpi-coding-agent";
import { isCodePreviewSettings } from "zpi-ui/code-preview";
import type {
  CombinedSelection,
  InterfacePreferences,
  ModelSelection,
  ModelSettings,
  ProviderInput,
  ProviderRecord,
  PublicSettings,
  WebSearchSettingsInput,
} from "../shared/bridge.ts";
import {
  availablePresets,
  defaultPreferences,
  defaultPreset,
  modelDefaults,
  sidebarLimits,
  toThinking,
  uiFontSizeLimits,
} from "../shared/config.ts";
import { memoryMode } from "../shared/plugins.ts";
import {
  defaultShortcuts,
  normalizeShortcuts,
  type ShortcutSettings,
  validateShortcuts,
} from "../shared/shortcuts.ts";
import { validatePluginSettings } from "./plugins/settings.ts";
import { StateStore } from "./state-store.ts";
export function atomicJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
export interface CredentialEncryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
type ProviderData = Omit<ProviderRecord, "hasApiKey" | "chatgptAccount">;
interface Credentials {
  baseUrl: string;
  apiKey: string;
  chatgpt?: ChatGPTCredential;
}
export interface SettingsData {
  shortcuts: ShortcutSettings;
  plugins: PublicSettings["plugins"];
  webSearchEnabled: boolean;
  version: 5;
  templates: PromptTemplate[];
  selectedTemplateId: string;
  disabledSkillPaths: string[];
  providers: ProviderData[];
  lastSelection: CombinedSelection | null;
  interface: Omit<InterfacePreferences, "notificationEnabled">;
}
const { notificationEnabled: _notificationEnabled, ...defaultStoredPreferences } = defaultPreferences;
export function resolveModel(provider: ProviderData, input: ModelSettings): Model {
  const model: Model = {
    id: input.id,
    name: input.name?.trim() || input.id,
    api: providerApi(provider.preset, provider.api ?? "openai-completions"),
    ...(usesChatGPTAuth(provider.preset) ? { auth: "chatgpt" as const } : {}),
    provider: provider.id,
    baseUrl: provider.baseUrl,
    input: (input.input ?? ["text"]).filter(
      (type): type is "text" | "image" => type === "text" || type === "image",
    ),
    reasoning: input.reasoning ?? modelDefaults.reasoning,
    contextWindow: input.contextWindow ?? modelDefaults.contextWindow,
    maxTokens: input.maxTokens ?? modelDefaults.maxTokens,
    compat: { ...modelDefaults.compat, ...input.compat },
    ...(input.reasoningConfig ? { reasoningConfig: structuredClone(input.reasoningConfig) } : {}),
    ...(input.thinkingLevelMap ? { thinkingLevelMap: structuredClone(input.thinkingLevelMap) } : {}),
    ...(input.defaultThinkingLevel ? { defaultThinkingLevel: input.defaultThinkingLevel } : {}),
    ...(input.samplingParams ? { samplingParams: structuredClone(input.samplingParams) } : {}),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  model.defaultThinkingLevel = toThinking(defaultPreset(model), model);
  return model;
}
export class SettingsStore {
  private data: SettingsData = {
    shortcuts: defaultShortcuts(process.platform),
    plugins: structuredClone(defaultPluginSettings),
    webSearchEnabled: false,
    version: 5,
    templates: [],
    selectedTemplateId: "pi",
    disabledSkillPaths: [],
    providers: [],
    lastSelection: null,
    interface: structuredClone(defaultStoredPreferences),
  };
  private credentials: Record<string, Credentials> = {};
  private webApiKey = "";
  private refreshes = new Map<string, Promise<string>>();
  private persisted = false;
  private unreadCredentials = false;
  private dir: string;
  private encryption: CredentialEncryption;
  readonly state: StateStore;
  private ownsState: boolean;
  constructor(dir: string, encryption: CredentialEncryption, state?: StateStore) {
    this.ownsState = !state;
    this.state = state ?? new StateStore(join(dir, "state.sqlite"));
    this.dir = dir;
    this.encryption = encryption;
    try {
      const creds = join(dir, "credentials.enc");
      const raw = this.state.getSetting<SettingsData>("app");
      if (raw !== undefined) {
        this.validateData(raw);
        this.data = raw;
      }
      if (existsSync(creds)) {
        if (!encryption.isEncryptionAvailable()) this.unreadCredentials = true;
        else {
          const raw: unknown = JSON.parse(encryption.decryptString(readFileSync(creds)));
          if (!isJsonObject(raw)) throw new Error("storage: Invalid credential record");
          if (raw.version !== 4) throw new Error("storage: Unsupported credential format");
          const values = raw.providers;
          if (!isJsonObject(values)) throw new Error("storage: Invalid credential providers");
          for (const [id, value] of Object.entries(values)) {
            if (!isJsonObject(value) || typeof value.baseUrl !== "string" || typeof value.apiKey !== "string")
              throw new Error("storage: Invalid credential record");
            if (this.data.providers.find((p) => p.id === id)?.baseUrl === value.baseUrl)
              this.credentials[id] = {
                baseUrl: value.baseUrl,
                apiKey: value.apiKey,
                ...(isChatGPTCredential(value.chatgpt) ? { chatgpt: value.chatgpt } : {}),
              };
          }
          if (raw.webSearch !== undefined) {
            if (!isJsonObject(raw.webSearch) || typeof raw.webSearch.apiKey !== "string")
              throw new Error("storage: Invalid web search credentials");
            this.webApiKey = raw.webSearch.apiKey;
          }
          this.persisted = true;
        }
      }
    } catch (error) {
      this.close();
      throw error;
    }
  }
  close(): void {
    if (this.ownsState) {
      this.state.close();
      this.ownsState = false;
    }
  }
  get(): PublicSettings {
    return {
      webSearch: {
        provider: "deepseek",
        enabled: this.data.webSearchEnabled,
        hasApiKey: Boolean(this.webApiKey),
        apiKeyLength: this.unreadCredentials ? 0 : this.webApiKey.length,
        credentialsPersisted: this.persisted,
        credentialsLocked: this.unreadCredentials,
      },
      shortcuts: structuredClone(this.data.shortcuts),
      plugins: structuredClone(this.data.plugins),
      providers: this.data.providers.map((p) => ({
        ...structuredClone(p),
        hasApiKey: Boolean(this.credentials[p.id]?.apiKey),
        ...(this.credentials[p.id]?.chatgpt
          ? {
              chatgptAccount: {
                label: `${this.credentials[p.id].chatgpt?.email ?? "ChatGPT"} · ${this.credentials[p.id].chatgpt?.clientId.slice(-8)}`,
                connected: Boolean(
                  this.credentials[p.id].chatgpt?.access && this.credentials[p.id].chatgpt?.refresh,
                ),
              },
            }
          : {}),
      })),
      lastSelection: structuredClone(this.data.lastSelection),
      interface: {
        ...structuredClone(this.data.interface),
        notificationEnabled: this.data.plugins.enabled[desktopPluginIds.notifications] !== false,
      },
      credentialsPersisted: this.persisted,
      disabledSkillPaths: [...this.data.disabledSkillPaths],
    };
  }
  // Main-process only. Web tools never use a chat provider's credentials or environment keys.
  getWebSearchApiKey(): string {
    if (this.unreadCredentials) throw new Error("configuration: 保存的联网搜索凭据尚未解锁");
    if (!this.data.webSearchEnabled) throw new Error("configuration: DeepSeek 联网搜索服务已停用");
    return this.webApiKey;
  }
  // Explicit settings reveal may read a saved key even when the service is disabled.
  getWebSearchCredentials(): { apiKey: string } {
    if (this.unreadCredentials) throw new Error("configuration: 保存的联网搜索凭据尚未解锁");
    return { apiKey: this.webApiKey };
  }
  saveWebSearch(input: WebSearchSettingsInput): PublicSettings {
    if (!isJsonObject(input)) throw new Error("invalid_input: 联网搜索配置必须为对象");
    assertSupportedOptions(input, ["provider", "apiKey", "enabled"], "web search settings");
    if (input.provider !== "deepseek") throw new Error("invalid_input: 不支持的联网搜索提供商");
    if (input.enabled !== undefined && typeof input.enabled !== "boolean")
      throw new Error("invalid_input: 联网搜索服务状态无效");
    if (
      input.apiKey !== undefined &&
      (typeof input.apiKey !== "string" || input.apiKey.length > 8192 || /[\r\n\0]/.test(input.apiKey))
    )
      throw new Error("invalid_input: 联网搜索 API key 无效");
    const webApiKey = input.apiKey === undefined ? this.webApiKey : input.apiKey.trim();
    if (input.enabled === true) {
      if (this.unreadCredentials) throw new Error("configuration: 保存的联网搜索凭据尚未解锁");
      if (!webApiKey) throw new Error("configuration: 请先配置 DeepSeek 联网搜索 API Key");
    }
    const data = {
      ...this.data,
      ...(input.enabled !== undefined ? { webSearchEnabled: input.enabled } : {}),
    };
    if (input.apiKey === undefined) return this.savePublic(data);
    this.persist(data, this.credentials, webApiKey);
    return this.get();
  }
  getMemorySettings(): MemorySettings {
    const saved = this.state.getSetting<Omit<MemorySettings, "short" | "long">>("memory.settings");
    if (saved !== undefined)
      assertSupportedOptions(
        saved,
        Object.keys(defaultMemorySettings).filter((key) => key !== "short" && key !== "long"),
        "memory pipeline settings",
      );
    const mode = memoryMode(this.data.plugins);
    const value = { ...(saved ?? defaultMemorySettings), short: mode === "short", long: mode === "long" };
    this.validateMemorySettings(value);
    return structuredClone(value);
  }
  saveMemorySettings(input: MemorySettings): MemorySettings {
    this.validateMemorySettings(input);
    if (input.short && input.long) throw new Error("invalid_input: 短记忆和长期记忆不能同时开启");
    const previous = this.getMemorySettings();
    for (const key of ["selection", "extractSelection", "consolidateSelection"] as const) {
      const selection = input[key];
      if (!selection) continue;
      const provider = this.data.providers.find((item) => item.id === selection.provider);
      const model = provider?.models.find((item) => item.id === selection.modelId);
      // Missing models remain saved so the pipeline can report the exact unavailable selection.
      // Provider edits may invalidate a saved selection; that must not prevent pausing or disabling memory.
      const unchanged =
        previous[key]?.provider === selection.provider &&
        previous[key]?.modelId === selection.modelId &&
        previous[key]?.reasoning === selection.reasoning;
      if (
        !unchanged &&
        provider &&
        model &&
        !availablePresets(resolveModel(provider, model)).includes(selection.reasoning)
      )
        throw new Error("configuration: 记忆模型不支持所选思考级别");
    }
    const { short, long, ...pipeline } = input;
    const data = {
      ...this.data,
      plugins: {
        ...this.data.plugins,
        enabled: {
          ...this.data.plugins.enabled,
          ...(short || long ? { [desktopPluginIds.memory]: true } : {}),
        },
        options: {
          ...this.data.plugins.options,
          [desktopPluginIds.memory]: { mode: long ? "long" : short ? "short" : "off" },
        },
      },
    };
    this.validateData(data);
    this.state.transaction("memory.settings", "memory", () => {
      this.state.setSetting("memory.settings", structuredClone(pipeline));
      this.state.setSetting("app", data);
    });
    this.data = data;
    return this.getMemorySettings();
  }
  private validateMemorySettings(value: unknown): asserts value is MemorySettings {
    if (!isJsonObject(value)) throw new Error("invalid_input: 记忆设置必须为对象");
    assertSupportedOptions(value, Object.keys(defaultMemorySettings), "invalid_input: memory settings");
    for (const name of ["short", "long", "generate"])
      if (typeof value[name] !== "boolean") throw new Error("invalid_input: 记忆开关无效");
    if (value.modelMode !== "follow" && value.modelMode !== "manual")
      throw new Error("invalid_input: 记忆模型策略无效");
    for (const name of ["selection", "extractSelection", "consolidateSelection"]) {
      const selection = value[name];
      if (selection === null) continue;
      if (!isJsonObject(selection)) throw new Error("invalid_input: 记忆模型配置无效");
      assertSupportedOptions(
        selection,
        ["provider", "modelId", "reasoning"],
        "invalid_input: memory model selection",
      );
      for (const key of ["provider", "modelId", "reasoning"])
        if (
          typeof selection[key] !== "string" ||
          !selection[key].trim() ||
          selection[key].length > 256 ||
          /[\r\n\0]/.test(selection[key])
        )
          throw new Error("invalid_input: 记忆模型配置无效");
    }
    for (const [name, limits] of Object.entries(memorySettingLimits)) {
      const number = value[name];
      if (
        typeof number !== "number" ||
        !Number.isInteger(number) ||
        number < limits.min ||
        number > limits.max
      )
        throw new Error(`invalid_input: ${name} 必须为 ${limits.min}–${limits.max} 的整数`);
    }
  }
  getModel(selection: ModelSelection): Model | undefined {
    const p = this.data.providers.find((p) => p.id === selection.provider),
      m = p?.models.find((m) => m.id === selection.modelId);
    return p && p.enabled !== false && m && m.enabled !== false ? resolveModel(p, m) : undefined;
  }
  isSelectionValid(selection: CombinedSelection): boolean {
    const model = this.getModel(selection);
    return Boolean(
      model &&
        typeof selection.reasoning === "string" &&
        canControlThinking(model, toThinking(selection.reasoning, model)),
    );
  }
  getProviderCredentials(id: string): { apiKey: string } {
    if (!this.data.providers.some((p) => p.id === id)) throw new Error("not_found: 提供商不存在");
    if (this.unreadCredentials) throw new Error("configuration: 保存的凭据尚未解锁，无法读取");
    if (usesChatGPTAuth(this.data.providers.find((p) => p.id === id)?.preset)) return { apiKey: "" };
    return { apiKey: this.credentials[id]?.apiKey ?? "" };
  }
  snapshot(providerId = "custom"): ProviderInput & { id: string; apiKey: string } {
    const p = this.data.providers.find((p) => p.id === providerId);
    if (!p) throw new Error("configuration: 所选提供商已删除，请选择新模型");
    return structuredClone({ ...p, ...this.getProviderCredentials(providerId) });
  }
  saveProvider(input: ProviderInput, chatgptCredential?: ChatGPTCredential): PublicSettings {
    if (!isJsonObject(input)) throw new Error("configuration: 提供商配置必须为对象");
    assertSupportedOptions(
      input,
      ["id", "name", "baseUrl", "models", "apiKey", "preset", "enabled", "api"],
      "provider settings",
    );
    if (typeof input.name !== "string" || typeof input.baseUrl !== "string")
      throw new Error("configuration: 名称和 Base URL 必填");
    const id = input.id ?? randomUUID();
    const provider = {
      id,
      ...(input.api !== undefined ? { api: input.api } : {}),
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      models: structuredClone(input.models),
    };
    this.validateProvider(provider);
    if (usesChatGPTAuth(input.preset) && input.apiKey !== undefined)
      throw new Error("configuration: ChatGPT 提供商需要登录授权");
    if (
      chatgptCredential !== undefined &&
      (!usesChatGPTAuth(input.preset) || !isChatGPTCredential(chatgptCredential))
    )
      throw new Error("configuration: 无效 ChatGPT 凭据");
    if (input.apiKey !== undefined && typeof input.apiKey !== "string")
      throw new Error("configuration: 无效凭据");
    if (this.unreadCredentials && input.apiKey === undefined)
      throw new Error("configuration: 保存的凭据尚未解锁");
    const chatgpt = chatgptCredential ?? this.credentials[id]?.chatgpt;
    const credentials = {
      ...this.credentials,
      [id]: {
        baseUrl: provider.baseUrl,
        apiKey: input.apiKey ?? this.credentials[id]?.apiKey ?? "",
        ...(usesChatGPTAuth(input.preset) && chatgpt ? { chatgpt: structuredClone(chatgpt) } : {}),
      },
    };
    const providers = this.data.providers.some((p) => p.id === id)
      ? this.data.providers.map((p) => (p.id === id ? provider : p))
      : [...this.data.providers, provider];
    this.persist({ ...this.data, providers }, credentials);
    return this.get();
  }
  getChatGPTHostId(): string {
    const file = join(this.dir, "chatgpt-host.json");
    if (existsSync(file)) {
      const data: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (isJsonObject(data) && typeof data.hostId === "string") return data.hostId;
      throw new Error("storage: ChatGPT 安装标识损坏");
    }
    const hostId = `urn:uuid:${randomUUID()}`;
    atomicJson(file, { hostId });
    return hostId;
  }
  getChatGPTCredential(id: string): ChatGPTCredential | undefined {
    if (this.unreadCredentials) throw new Error("configuration: 保存的凭据尚未解锁");
    if (!usesChatGPTAuth(this.data.providers.find((p) => p.id === id)?.preset))
      throw new Error("configuration: 不是 ChatGPT 提供商");
    return structuredClone(this.credentials[id]?.chatgpt);
  }
  saveChatGPTCredential(id: string, credential: ChatGPTCredential): PublicSettings {
    this.getChatGPTCredential(id);
    if (!isChatGPTCredential(credential)) throw new Error("configuration: 无效 ChatGPT 凭据");
    this.persist(this.data, {
      ...this.credentials,
      [id]: {
        baseUrl: this.credentials[id]?.baseUrl ?? this.snapshot(id).baseUrl,
        apiKey: "",
        chatgpt: structuredClone(credential),
      },
    });
    return this.get();
  }
  disconnectChatGPT(id: string): PublicSettings {
    const credential = this.getChatGPTCredential(id);
    if (!credential) return this.get();
    const { identityPending: _identityPending, ...disconnected } = credential;
    return this.saveChatGPTCredential(id, {
      ...disconnected,
      access: "",
      refresh: "",
      idToken: "",
      expires: 0,
      scopes: [],
    });
  }
  async getRequestApiKey(
    id: string,
    fetcher: typeof fetch = fetch,
    rejectedApiKey?: string,
  ): Promise<string> {
    const provider = this.data.providers.find((p) => p.id === id);
    if (!provider) throw new Error("configuration: 所选提供商已删除");
    if (!usesChatGPTAuth(provider.preset)) return this.getProviderCredentials(id).apiKey;
    const pending = this.refreshes.get(id);
    if (pending) return pending;
    const credential = this.getChatGPTCredential(id);
    if (!credential?.access || !credential.refresh) throw new Error("configuration: 请先登录 ChatGPT");
    if (
      !credential.identityPending &&
      credential.access !== rejectedApiKey &&
      credential.expires > Date.now() + 3 * 60 * 1000
    )
      return credential.access;
    const refresh = (async () => {
      let expected = credential;
      const save = (next: ChatGPTCredential) => {
        const current = this.getChatGPTCredential(id);
        if (current?.refresh !== expected.refresh || current.access !== expected.access)
          throw new Error("configuration: ChatGPT 登录状态已改变，请重试");
        if (next !== expected) this.saveChatGPTCredential(id, next);
        expected = next;
      };
      const next = credential.identityPending
        ? await verifyRefreshedChatGPTCredential(credential, fetcher)
        : await refreshChatGPTCredential(credential, fetcher, save);
      save(next);
      return next.access;
    })();
    this.refreshes.set(id, refresh);
    try {
      return await refresh;
    } finally {
      if (this.refreshes.get(id) === refresh) this.refreshes.delete(id);
    }
  }
  reorderProviders(ids: string[]): PublicSettings {
    if (
      !Array.isArray(ids) ||
      ids.length !== this.data.providers.length ||
      new Set(ids).size !== ids.length ||
      ids.some((id) => !this.data.providers.some((provider) => provider.id === id))
    )
      throw new Error("invalid_input: 提供商排序必须包含全部提供商");
    const providers = [...this.data.providers].sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
    const data = { ...this.data, providers };
    this.state.setSetting("app", data);
    this.data = data;
    return this.get();
  }
  discoverEnvironment(env: Record<string, string | undefined>): string[] {
    // Discovery is optional; never replace credentials that could not be decrypted.
    if (this.unreadCredentials) return [];
    const added: string[] = [];
    for (const discovery of discoverProviderCredentials(env)) {
      const preset = getProviderPreset(discovery.preset);
      if (!preset || this.data.providers.some((provider) => provider.preset === preset.id)) continue;
      const id = `env-${preset.id}`;
      if (this.data.providers.some((provider) => provider.id === id)) continue;
      this.saveProvider({
        id,
        preset: preset.id,
        name: preset.name,
        baseUrl: providerBaseUrl(preset.id),
        api: providerApi(preset.id),
        models: presetModels(preset.id, providerApi(preset.id)).map((model) => ({
          ...model,
          useRecommendedConfig: true,
          metadataSource: "catalog",
        })),
        apiKey: discovery.apiKey,
      });
      added.push(id);
    }
    return added;
  }
  deleteProvider(id: string): PublicSettings {
    const providers = this.data.providers.filter((p) => p.id !== id);
    if (providers.length === this.data.providers.length) throw new Error("not_found: 提供商不存在");
    const credentials = { ...this.credentials };
    delete credentials[id];
    this.persist({ ...this.data, providers }, credentials);
    return this.get();
  }
  rememberSelection(selection: CombinedSelection): void {
    if (!this.isSelectionValid(selection)) throw new Error("configuration: 请重新选择有效模型与思考程度");
    const data = { ...this.data, lastSelection: { ...selection } };
    this.state.setSetting("app", data);
    this.data = data;
  }
  updateShortcuts(input: ShortcutSettings): PublicSettings {
    return this.savePublic({ ...this.data, shortcuts: normalizeShortcuts(input, process.platform) });
  }
  updatePreferences(input: Partial<InterfacePreferences>): PublicSettings {
    if (Object.hasOwn(input, "notificationEnabled") && typeof input.notificationEnabled !== "boolean")
      throw new Error("configuration: 无效通知设置");
    const { notificationEnabled, ...preferences } = input;
    return this.savePublic({
      ...this.data,
      interface: { ...this.data.interface, ...preferences },
      ...(notificationEnabled !== undefined
        ? {
            plugins: {
              ...this.data.plugins,
              enabled: {
                ...this.data.plugins.enabled,
                [desktopPluginIds.notifications]: notificationEnabled,
              },
            },
          }
        : {}),
    });
  }
  setPluginEnabled(id: string, enabled: boolean): PublicSettings {
    if (
      (!builtinPluginCatalog.some((plugin) => plugin.id === id) &&
        !(this.state.getSetting<{ id: string }[]>("plugins.local") ?? []).some(
          (plugin) => plugin.id === id,
        )) ||
      typeof enabled !== "boolean"
    )
      throw new Error("invalid_input: 无效插件");
    return this.savePublic({
      ...this.data,
      plugins: { ...this.data.plugins, enabled: { ...this.data.plugins.enabled, [id]: enabled } },
    });
  }
  setPluginOptions(id: string, options: import("zpi-ai").JsonObject): PublicSettings {
    if (!builtinPluginCatalog.some((plugin) => plugin.id === id) || !isJsonObject(options))
      throw new Error("invalid_input: 无效插件配置");
    validateBuiltinPluginOptions(id, options);
    return this.savePublic({
      ...this.data,
      plugins: {
        ...this.data.plugins,
        options: { ...this.data.plugins.options, [id]: structuredClone(options) },
      },
    });
  }
  getTemplate(): PromptTemplate {
    return structuredClone(
      this.data.templates.find((t) => t.id === this.data.selectedTemplateId) ?? piTemplate,
    );
  }
  isSkillEnabled(path: string): boolean {
    return !this.data.disabledSkillPaths.includes(resolve(path));
  }
  setSkillEnabled(path: string, enabled: boolean): PublicSettings {
    if (typeof enabled !== "boolean") throw new Error("invalid_input: 无效技能状态");
    const normalized = resolve(path);
    return this.savePublic({
      ...this.data,
      disabledSkillPaths: [
        ...this.data.disabledSkillPaths.filter((p) => p !== normalized),
        ...(enabled ? [] : [normalized]),
      ],
    });
  }
  private savePublic(data: SettingsData): PublicSettings {
    this.validateData(data);
    this.state.setSetting("app", data);
    this.data = data;
    return this.get();
  }
  private persist(
    data: SettingsData,
    credentials: Record<string, Credentials>,
    webApiKey = this.webApiKey,
  ): void {
    this.validateData(data);
    if (this.unreadCredentials) throw new Error("configuration: 保存的凭据尚未解锁");
    const encrypted = this.encryption.isEncryptionAvailable();
    this.writeConfiguration(data, encrypted ? credentials : undefined, webApiKey);
    if (!encrypted) rmSync(join(this.dir, "credentials.enc"), { force: true });
    this.data = data;
    this.credentials = credentials;
    this.webApiKey = webApiKey;
    this.persisted = encrypted;
  }
  private writeConfiguration(
    data: SettingsData,
    credentials?: Record<string, Credentials>,
    webApiKey = this.webApiKey,
  ): void {
    // Credential-only updates reuse this.data; rotated tokens must not depend on an unchanged DB write.
    if (!credentials) {
      if (data !== this.data) this.state.setSetting("app", data);
      return;
    }
    // Preserve the encrypted-file contract; restore its bytes if the database commit fails.
    const encrypted = this.encryption.encryptString(
      JSON.stringify({ version: 4, providers: credentials, webSearch: { apiKey: webApiKey } }),
    );
    mkdirSync(this.dir, { recursive: true });
    const creds = join(this.dir, "credentials.enc");
    const token = randomUUID(),
      credsTemp = `${creds}.${token}.tmp`;
    const previous = existsSync(creds) ? readFileSync(creds) : undefined;
    let replaced = false;
    try {
      writeFileSync(credsTemp, encrypted, { mode: 0o600 });
      renameSync(credsTemp, creds);
      replaced = true;
      if (data !== this.data) this.state.setSetting("app", data);
    } catch (error) {
      if (replaced) {
        if (previous) {
          writeFileSync(credsTemp, previous, { mode: 0o600 });
          renameSync(credsTemp, creds);
        } else rmSync(creds, { force: true });
      }
      throw error;
    } finally {
      rmSync(credsTemp, { force: true });
    }
  }
  private validateData(data: SettingsData): void {
    assertSupportedOptions(
      data,
      [
        "version",
        "providers",
        "lastSelection",
        "interface",
        "templates",
        "selectedTemplateId",
        "disabledSkillPaths",
        "plugins",
        "webSearchEnabled",
        "shortcuts",
      ],
      "settings",
    );
    const shortcutError = validateShortcuts(data.shortcuts, process.platform);
    if (shortcutError) throw new Error(`storage: ${shortcutError}`);
    if (data.version !== 5 || !Array.isArray(data.providers)) throw new Error("storage: Invalid settings");
    if (typeof data.webSearchEnabled !== "boolean")
      throw new Error("storage: Invalid web search provider state");
    validatePluginSettings(data.plugins);
    if (
      !Array.isArray(data.templates) ||
      !Array.isArray(data.disabledSkillPaths) ||
      data.disabledSkillPaths.some((p) => typeof p !== "string" || p !== resolve(p)) ||
      !["pi", ...data.templates.map((t) => t.id)].includes(data.selectedTemplateId)
    )
      throw new Error("storage: Invalid prompt/skill settings");
    for (const t of data.templates) {
      validateTemplate(t);
      if (t.id === "pi") throw new Error("invalid_input: 内置模板只读");
    }
    if (new Set(data.templates.map((t) => t.id)).size !== data.templates.length)
      throw new Error("invalid_input: 重复模板 ID");
    for (const p of data.providers) this.validateProvider(p);
    if (new Set(data.providers.map((p) => p.id)).size !== data.providers.length)
      throw new Error("configuration: 重复提供商 ID");
    const selection = data.lastSelection;
    if (
      selection !== null &&
      (!isJsonObject(selection) ||
        typeof selection.provider !== "string" ||
        typeof selection.modelId !== "string" ||
        typeof selection.reasoning !== "string" ||
        !selection.reasoning.trim() ||
        selection.reasoning.length > 128)
    )
      throw new Error("storage: Invalid model selection");
    const prefs = data.interface;
    if (!isJsonObject(prefs)) throw new Error("storage: Invalid interface preferences");
    assertSupportedOptions(prefs, Object.keys(defaultStoredPreferences), "interface preferences");
    if (prefs.codePreview !== undefined && !isCodePreviewSettings(prefs.codePreview))
      throw new Error("configuration: 无效代码预览设置");
    if (
      [
        prefs.showContextUsage,
        prefs.showModelPerformance,
        prefs.showSendButton,
        prefs.notificationSoundEnabled,
        prefs.sidebarCollapsed,
        prefs.projectsCollapsed,
        prefs.tasksCollapsed,
      ].some((v) => typeof v !== "boolean") ||
      !["system", "light", "dark"].includes(prefs.theme) ||
      !Number.isInteger(prefs.fontSize) ||
      prefs.fontSize < uiFontSizeLimits.min ||
      prefs.fontSize > uiFontSizeLimits.max ||
      !Number.isFinite(prefs.sidebarWidth) ||
      prefs.sidebarWidth < sidebarLimits.min ||
      prefs.sidebarWidth > sidebarLimits.max ||
      !Array.isArray(prefs.collapsedProjectIds) ||
      prefs.collapsedProjectIds.some((id) => typeof id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(id))
    )
      throw new Error("configuration: 无效界面设置");
  }
  private validateProvider(p: ProviderData): void {
    if (!isJsonObject(p)) throw new Error("configuration: 无效提供商");
    assertSupportedOptions(
      p,
      ["id", "name", "baseUrl", "models", "preset", "enabled", "api"],
      "provider record",
    );
    if (p.api !== undefined && !providerApis(p.preset).includes(p.api))
      throw new Error("configuration: 不支持的 API 格式");
    if (
      p.preset &&
      (!getProviderPreset(p.preset) ||
        p.baseUrl !== providerBaseUrl(p.preset, providerApi(p.preset, p.api ?? "openai-completions")))
    )
      throw new Error("configuration: 预置提供商的地址不匹配");
    if (
      typeof p.id !== "string" ||
      !/^[a-zA-Z0-9_-]+$/.test(p.id) ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 200 ||
      (p.enabled !== undefined && typeof p.enabled !== "boolean")
    )
      throw new Error("configuration: 提供商名称不能为空");
    let url: URL;
    try {
      url = new URL(p.baseUrl);
    } catch {
      throw new Error("configuration: base URL 无效");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname.replace(/\/$/, "").endsWith("/chat/completions")
    )
      throw new Error("configuration: 输入 API 前缀 URL，例如 http://127.0.0.1:8000/v1");
    if (!Array.isArray(p.models)) throw new Error("configuration: 无效模型列表");
    for (const m of p.models) {
      if (!isJsonObject(m)) throw new Error("configuration: 无效模型");
      assertSupportedOptions(
        m,
        [
          "id",
          "name",
          "enabled",
          "useRecommendedConfig",
          "metadataSource",
          "input",
          "reasoning",
          "contextWindow",
          "maxTokens",
          "compat",
          "thinkingLevelMap",
          "reasoningConfig",
          "defaultThinkingLevel",
          "availability",
          "samplingParams",
        ],
        "model settings",
      );
      if (
        typeof m.id !== "string" ||
        !m.id.trim() ||
        m.id.length > 200 ||
        (m.name !== undefined && typeof m.name !== "string") ||
        (m.enabled !== undefined && typeof m.enabled !== "boolean") ||
        (m.reasoning !== undefined && typeof m.reasoning !== "boolean") ||
        (m.useRecommendedConfig !== undefined && typeof m.useRecommendedConfig !== "boolean") ||
        (m.metadataSource !== undefined &&
          !["remote", "catalog", "defaults"].includes(String(m.metadataSource)))
      )
        throw new Error("configuration: Model ID 必填");
      const context = m.contextWindow ?? modelDefaults.contextWindow,
        max = m.maxTokens ?? modelDefaults.maxTokens;
      if (!Number.isSafeInteger(context) || !Number.isSafeInteger(max) || max <= 0 || context < max)
        throw new Error("configuration: 上下文容量必须不小于输出上限且为正整数");
      if (
        m.input !== undefined &&
        (!Array.isArray(m.input) ||
          !m.input.includes("text") ||
          m.input.some((v) => !["text", "image", "video", "pdf"].includes(v)))
      )
        throw new Error("configuration: 输入类型仅支持文本、图片、视频和 PDF");
      if (m.compat !== undefined) {
        if (!isJsonObject(m.compat)) throw new Error("configuration: compat 必须为对象");
        assertSupportedOptions(
          m.compat,
          [...openAICompletionsCompatKeys, ...anthropicMessagesCompatKeys],
          "compat",
        );
        if (
          m.compat.structuredOutput !== undefined &&
          !["prompt", "json_object", "json_schema"].includes(m.compat.structuredOutput as string)
        )
          throw new Error("configuration: 无效 structuredOutput");
        for (const [k, v] of Object.entries(m.compat))
          if (
            k === "thinkingFormat"
              ? !["deepseek", "zai"].includes(String(v))
              : k === "maxTokensField"
                ? !["max_tokens", "max_completion_tokens"].includes(String(v))
                : k === "structuredOutput"
                  ? !["prompt", "json_object", "json_schema"].includes(String(v))
                  : k === "sessionAffinityFormat"
                    ? v !== "openrouter"
                    : k === "allowedFallbackModels"
                      ? !Array.isArray(v) ||
                        v.some(
                          (fallback) =>
                            !isJsonObject(fallback) ||
                            typeof fallback.provider !== "string" ||
                            typeof fallback.model !== "string" ||
                            !isJsonObject(fallback.cost) ||
                            ["input", "output", "cacheRead", "cacheWrite"].some(
                              (field) =>
                                typeof (fallback.cost as Record<string, unknown>)[field] !== "number" ||
                                (fallback.cost as Record<string, number>)[field] < 0,
                            ),
                        )
                      : typeof v !== "boolean"
          )
            throw new Error("configuration: 无效 compat");
      }
      if (m.reasoningConfig !== undefined) validateReasoningConfig(m.reasoningConfig);
      if (m.thinkingLevelMap !== undefined) validateThinkingMap(m.thinkingLevelMap);
      if (
        m.defaultThinkingLevel !== undefined &&
        (typeof m.defaultThinkingLevel !== "string" ||
          !m.defaultThinkingLevel.trim() ||
          !canControlThinking(resolveModel(p, m), m.defaultThinkingLevel))
      )
        throw new Error("configuration: 无效默认思考强度");
      if (m.availability !== undefined && !["listed", "unverified"].includes(m.availability))
        throw new Error("configuration: 无效模型可用性");
      if (m.samplingParams !== undefined && !isJsonObject(m.samplingParams))
        throw new Error("configuration: samplingParams 必须为 JSON 对象");
    }
    if (new Set(p.models.map((m) => m.id)).size !== p.models.length)
      throw new Error("configuration: 重复 Model ID");
  }
}
