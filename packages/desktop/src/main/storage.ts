import type { Model } from "ZPI-ai";
import {
  assertSupportedOptions,
  canControlThinking,
  discoverProviderCredentials,
  getProviderPreset,
  isJsonObject,
  openAICompletionsCompatKeys,
  presetModels,
  providerApi,
  usesChatGPTAuth,
  validateReasoningConfig,
  validateThinkingMap,
} from "ZPI-ai";
import {
  type ChatGPTCredential,
  isChatGPTCredential,
  refreshChatGPTCredential,
} from "ZPI-ai/auth/openai-chatgpt";
import { type PromptTemplate, piTemplate, validateTemplate } from "ZPI-coding-agent";
import { randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import type {
  CombinedSelection,
  InterfacePreferences,
  ModelSelection,
  ModelSettings,
  ProviderInput,
  ProviderRecord,
  PublicSettings,
  SettingsInput,
} from "../shared/bridge.ts";
import {
  defaultPreferences,
  modelDefaults,
  reasoningPresets,
  sidebarLimits,
  toPreset,
  toThinking,
  uiFontSizeLimits,
} from "../shared/config.ts";
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
interface SettingsData {
  version: 4;
  templates: PromptTemplate[];
  selectedTemplateId: string;
  disabledSkillPaths: string[];
  providers: ProviderData[];
  lastSelection: CombinedSelection | null;
  interface: InterfacePreferences;
}
export function resolveModel(provider: ProviderData, input: ModelSettings): Model {
  return {
    id: input.id,
    name: input.name?.trim() || input.id,
    api: providerApi(provider.preset),
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
}
export class SettingsStore {
  private data: SettingsData = {
    version: 4,
    templates: [],
    selectedTemplateId: "pi",
    disabledSkillPaths: [],
    providers: [],
    lastSelection: null,
    interface: structuredClone(defaultPreferences),
  };
  private credentials: Record<string, Credentials> = {};
  private refreshes = new Map<string, Promise<string>>();
  private persisted = false;
  private unreadCredentials = false;
  private dir: string;
  private encryption: CredentialEncryption;
  constructor(dir: string, encryption: CredentialEncryption) {
    this.dir = dir;
    this.encryption = encryption;
    const file = join(dir, "settings.json"),
      creds = join(dir, "credentials.enc");
    let oldVersion: 1 | 2 | 3 | undefined;
    let migratedFontSize = false;
    let clearedSelection = false;
    if (existsSync(file)) {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      if (!isJsonObject(raw)) throw new Error("storage: Invalid settings record");
      if (raw.version === 4) this.data = raw as unknown as SettingsData;
      else if (raw.version === 3) {
        this.data = {
          ...raw,
          version: 4,
          templates: [],
          selectedTemplateId: "pi",
          disabledSkillPaths: [],
        } as unknown as SettingsData;
        oldVersion = 3;
      } else {
        if (raw.version !== undefined && raw.version !== 1 && raw.version !== 2)
          throw new Error("storage: Unsupported settings version");
        oldVersion = raw.version === 2 ? 2 : 1;
        if (oldVersion === 1 && ("apiKey" in raw || "headers" in raw))
          throw new Error("storage: Credentials must not be stored in public settings");
        const { version: _version, ...legacy } = raw;
        const old =
          oldVersion === 2 ? raw.providers : this.legacy(legacy as unknown as SettingsInput).providers;
        if (!Array.isArray(old)) throw new Error("storage: Invalid providers");
        this.data.providers = old.map((p) => {
          if (!isJsonObject(p) || !Array.isArray(p.models))
            throw new Error("storage: Invalid provider record");
          return {
            ...p,
            models: p.models.map((m) => ({
              ...(m as ModelSettings),
              contextWindow: (m as ModelSettings).contextWindow ?? 32768,
              maxTokens: (m as ModelSettings).maxTokens ?? 4096,
              reasoning: (m as ModelSettings).reasoning ?? false,
              input: (m as ModelSettings).input ?? ["text"],
              compat: { supportsReasoningEffort: false, ...(m as ModelSettings).compat },
            })),
          } as ProviderData;
        });
        this.data.lastSelection = this.recoverLastSelection();
      }
      if (isJsonObject(this.data.interface)) {
        this.data.interface = { ...defaultPreferences, ...this.data.interface };
        const legacySize: unknown = this.data.interface.fontSize;
        const legacySizes: Record<string, number> = { small: 12, default: 14, large: 16 };
        if (typeof legacySize === "string" && Object.hasOwn(legacySizes, legacySize)) {
          this.data.interface.fontSize = legacySizes[legacySize];
          migratedFontSize = true;
        }
      }
      const lastSelection: unknown = this.data.lastSelection;
      if (
        isJsonObject(lastSelection) &&
        (typeof lastSelection.reasoning !== "string" ||
          !lastSelection.reasoning.trim() ||
          (!this.getModel(lastSelection as unknown as CombinedSelection)?.reasoningConfig &&
            !(reasoningPresets as readonly string[]).includes(lastSelection.reasoning)))
      ) {
        this.data.lastSelection = null;
        clearedSelection = true;
      }
      this.validateData(this.data);
    }
    if (existsSync(creds)) {
      if (!encryption.isEncryptionAvailable()) this.unreadCredentials = true;
      else {
        const raw: unknown = JSON.parse(encryption.decryptString(readFileSync(creds)));
        if (!isJsonObject(raw)) throw new Error("storage: Invalid credential record");
        const values = raw.version === 2 || raw.version === 3 ? raw.providers : { custom: raw };
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
        this.persisted = true;
      }
    }
    if (oldVersion) {
      for (const path of [file, creds])
        if (existsSync(path) && !existsSync(`${path}.v${oldVersion}.bak`))
          copyFileSync(path, `${path}.v${oldVersion}.bak`);
      this.writeConfiguration(this.data, encryption.isEncryptionAvailable() ? this.credentials : undefined);
    } else if (migratedFontSize || clearedSelection) atomicJson(file, this.data);
  }
  private recoverLastSelection(): CombinedSelection | null {
    const root = join(this.dir, "agent", "sessions");
    let latest: { time: number; selection: CombinedSelection } | undefined;
    if (!existsSync(root)) return null;
    for (const partition of readdirSync(root, { withFileTypes: true })) {
      if (!partition.isDirectory()) continue;
      for (const file of readdirSync(join(root, partition.name))) {
        if (!file.endsWith(".jsonl")) continue;
        let thinking: Parameters<typeof toPreset>[0] = "off";
        let run: { time: number; selection: CombinedSelection } | undefined;
        for (const line of readFileSync(join(root, partition.name, file), "utf8").split("\n")) {
          try {
            const e = JSON.parse(line);
            if (e.type === "custom" && typeof e.customType === "string")
              e.customType = e.customType.replace(/^ZPI\./i, "ZPI.");
            if (e.type === "thinking_level_change") thinking = e.thinkingLevel;
            if (e.type === "custom" && e.customType === "ZPI.run" && e.data.phase === "start") {
              const c = e.data.modelConfig;
              run =
                c?.provider && c.modelId
                  ? {
                      time: e.data.startedAt,
                      selection: { provider: c.provider, modelId: c.modelId, reasoning: toPreset(thinking) },
                    }
                  : undefined;
            }
            if (
              e.type === "message" &&
              e.message.role === "assistant" &&
              run &&
              Number.isFinite(run.time) &&
              (!latest || run.time > latest.time)
            )
              latest = run;
          } catch {
            /* Damaged logs are diagnosed by the session loader. */
          }
        }
      }
    }
    return latest?.selection ?? null;
  }
  get(): PublicSettings {
    return {
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
      interface: structuredClone(this.data.interface),
      credentialsPersisted: this.persisted,
      disabledSkillPaths: [...this.data.disabledSkillPaths],
    };
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
  // Internal legacy shape remains useful to callers migrating old single-model settings.
  save(input: SettingsInput): PublicSettings {
    return this.saveProvider({
      ...this.legacy(input).providers[0],
      ...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
    });
  }
  saveProvider(input: ProviderInput): PublicSettings {
    if (!isJsonObject(input)) throw new Error("configuration: 提供商配置必须为对象");
    assertSupportedOptions(
      input,
      ["id", "name", "baseUrl", "models", "apiKey", "preset", "enabled"],
      "provider settings",
    );
    if (typeof input.name !== "string" || typeof input.baseUrl !== "string")
      throw new Error("configuration: 名称和 Base URL 必填");
    const id = input.id ?? randomUUID();
    const provider = {
      id,
      ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
      ...(input.preset ? { preset: input.preset } : {}),
      name: input.name.trim(),
      baseUrl: input.baseUrl.trim(),
      models: structuredClone(input.models),
    };
    this.validateProvider(provider);
    if (usesChatGPTAuth(input.preset) && input.apiKey !== undefined)
      throw new Error("configuration: ChatGPT 提供商需要登录授权");
    if (input.apiKey !== undefined && typeof input.apiKey !== "string")
      throw new Error("configuration: 无效凭据");
    if (this.unreadCredentials && input.apiKey === undefined)
      throw new Error("configuration: 保存的凭据尚未解锁");
    const credentials = {
      ...this.credentials,
      [id]: {
        baseUrl: provider.baseUrl,
        apiKey: input.apiKey ?? this.credentials[id]?.apiKey ?? "",
        ...(usesChatGPTAuth(input.preset) && this.credentials[id]?.chatgpt
          ? { chatgpt: this.credentials[id].chatgpt }
          : {}),
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
    return this.saveChatGPTCredential(id, {
      ...credential,
      access: "",
      refresh: "",
      idToken: "",
      expires: 0,
      scopes: [],
    });
  }
  async getRequestApiKey(id: string, fetcher: typeof fetch = fetch): Promise<string> {
    const provider = this.data.providers.find((p) => p.id === id);
    if (!provider) throw new Error("configuration: 所选提供商已删除");
    if (!usesChatGPTAuth(provider.preset)) return this.getProviderCredentials(id).apiKey;
    const pending = this.refreshes.get(id);
    if (pending) return pending;
    const credential = this.getChatGPTCredential(id);
    if (!credential?.access || !credential.refresh) throw new Error("configuration: 请先登录 ChatGPT");
    if (credential.expires > Date.now() + 3 * 60 * 1000) return credential.access;
    const refresh = (async () => {
      const next = await refreshChatGPTCredential(credential, fetcher);
      const current = this.getChatGPTCredential(id);
      if (current?.refresh !== credential.refresh || current.access !== credential.access)
        throw new Error("configuration: ChatGPT 登录状态已改变，请重试");
      this.saveChatGPTCredential(id, next);
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
    atomicJson(join(this.dir, "settings.json"), data);
    this.data = data;
    return this.get();
  }
  discoverEnvironment(env: Record<string, string | undefined>): string[] {
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
        baseUrl: preset.baseUrl,
        models: presetModels(preset.id).map((model) => ({
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
    atomicJson(join(this.dir, "settings.json"), data);
    this.data = data;
  }
  updatePreferences(input: Partial<InterfacePreferences>): PublicSettings {
    const data = { ...this.data, interface: { ...this.data.interface, ...input } };
    this.validateData(data);
    atomicJson(join(this.dir, "settings.json"), data);
    this.data = data;
    return this.get();
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
    atomicJson(join(this.dir, "settings.json"), data);
    this.data = data;
    return this.get();
  }
  private persist(data: SettingsData, credentials: Record<string, Credentials>): void {
    this.validateData(data);
    if (this.unreadCredentials) throw new Error("configuration: 保存的凭据尚未解锁");
    const encrypted = this.encryption.isEncryptionAvailable();
    this.writeConfiguration(data, encrypted ? credentials : undefined);
    if (!encrypted) rmSync(join(this.dir, "credentials.enc"), { force: true });
    this.data = data;
    this.credentials = credentials;
    this.persisted = encrypted;
  }
  private writeConfiguration(data: SettingsData, credentials?: Record<string, Credentials>): void {
    if (!credentials) {
      atomicJson(join(this.dir, "settings.json"), data);
      return;
    }
    // Stage both files before replacing either. Restore encrypted bytes if the settings rename fails.
    const encrypted = this.encryption.encryptString(JSON.stringify({ version: 3, providers: credentials }));
    mkdirSync(this.dir, { recursive: true });
    const settings = join(this.dir, "settings.json"),
      creds = join(this.dir, "credentials.enc");
    const token = randomUUID(),
      settingsTemp = `${settings}.${token}.tmp`,
      credsTemp = `${creds}.${token}.tmp`;
    const previous = existsSync(creds) ? readFileSync(creds) : undefined;
    let replaced = false;
    try {
      writeFileSync(settingsTemp, JSON.stringify(data, null, 2), { mode: 0o600 });
      writeFileSync(credsTemp, encrypted, { mode: 0o600 });
      renameSync(credsTemp, creds);
      replaced = true;
      renameSync(settingsTemp, settings);
    } catch (error) {
      if (replaced) {
        if (previous) {
          writeFileSync(credsTemp, previous, { mode: 0o600 });
          renameSync(credsTemp, creds);
        } else rmSync(creds, { force: true });
      }
      throw error;
    } finally {
      rmSync(settingsTemp, { force: true });
      rmSync(credsTemp, { force: true });
    }
  }
  private legacy(input: SettingsInput): SettingsData {
    assertSupportedOptions(
      input,
      [
        "baseUrl",
        "modelId",
        "apiKey",
        "headers",
        "supportsImages",
        "reasoning",
        "contextWindow",
        "maxTokens",
        "compat",
      ],
      "legacy settings",
    );
    return {
      version: 4,
      templates: [],
      selectedTemplateId: "pi",
      disabledSkillPaths: [],
      providers: [
        {
          id: "custom",
          name: "Custom",
          baseUrl: input.baseUrl,
          models: [
            {
              id: input.modelId,
              input: input.supportsImages ? ["text", "image"] : ["text"],
              reasoning: input.reasoning,
              contextWindow: input.contextWindow,
              maxTokens: input.maxTokens,
              compat: { supportsReasoningEffort: false, ...input.compat },
            },
          ],
        },
      ],
      lastSelection: null,
      interface: structuredClone(defaultPreferences),
    };
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
      ],
      "settings",
    );
    if (data.version !== 4 || !Array.isArray(data.providers)) throw new Error("storage: Invalid settings");
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
    assertSupportedOptions(prefs, Object.keys(defaultPreferences), "interface preferences");
    if (
      [
        prefs.showContextUsage,
        prefs.showSendButton,
        prefs.notificationEnabled,
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
    assertSupportedOptions(p, ["id", "name", "baseUrl", "models", "preset", "enabled"], "provider record");
    if (p.preset && (!getProviderPreset(p.preset) || p.baseUrl !== getProviderPreset(p.preset)?.baseUrl))
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
        assertSupportedOptions(m.compat, openAICompletionsCompatKeys, "compat");
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
