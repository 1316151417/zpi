import { randomUUID } from "node:crypto";
import type { DiscoveredModel } from "@zpi-dev/ai";
import {
  beginChatGPTLogin,
  type ChatGPTCredential,
  type ChatGPTLogin,
  isChatGPTCredential,
  refreshChatGPTCredential,
  revokeChatGPTCredential,
  verifyRefreshedChatGPTCredential,
} from "@zpi-dev/ai/auth/openai-chatgpt";
import {
  type Account,
  AccountStore,
  billing,
  type CredentialSource,
  type SecretStore,
  type Service,
  systemSecrets,
  validModelId,
} from "./store.ts";

export interface ModelBinding {
  provider: string;
  modelId: string;
  accountId: string;
}
export type LoginSource =
  | { kind: "oauth"; reuse?: boolean }
  | { kind: "key"; value: string }
  | { kind: "env"; name: string }
  | { kind: "none" };
export interface LoginInteraction {
  authorize(login: ChatGPTLogin): Promise<ChatGPTCredential>;
  chooseModels(
    candidates: DiscoveredModel[],
    previous: DiscoveredModel[],
    manual: boolean,
  ): Promise<DiscoveredModel[]>;
  chooseDefault(ids: string[]): Promise<string>;
  warn(message: string): void;
  signal?: AbortSignal;
}
interface AccountOptions {
  secrets?: SecretStore;
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
}

function parseSelection(selector: string) {
  const slash = selector.indexOf("/");
  if (slash < 1 || !validModelId(selector.slice(slash + 1)))
    throw new Error("模型格式应为 服务名/模型ID，可用模型见 zpi models。");
  return { provider: selector.slice(0, slash), modelId: selector.slice(slash + 1) };
}
function noAccount() {
  return new Error(
    "账户已移除或尚未激活，请用 zpi auth list 查看连接，再用 zpi auth switch 或 zpi auth login。",
  );
}
function decodeCredential(raw: string | null) {
  try {
    const value: unknown = raw && JSON.parse(raw);
    if (isChatGPTCredential(value)) return value;
  } catch {
    // Parser errors may contain portions of the credential.
  }
  return undefined;
}
function savedCredential(store: SecretStore, ref: string) {
  const credential = decodeCredential(store.get(ref));
  if (credential) return credential;
  throw new Error(
    "CLI 订阅凭据缺失或损坏，请用 zpi auth logout 移除该连接，再运行 zpi auth login openai --method oauth。",
  );
}

export class Accounts {
  private store: AccountStore;
  private secrets: SecretStore;
  private requestFetch?: typeof fetch;
  private env: NodeJS.ProcessEnv;
  constructor(root: string, options: AccountOptions = {}) {
    this.store = new AccountStore(root);
    this.secrets = options.secrets ?? systemSecrets;
    this.requestFetch = options.fetch;
    this.env = options.env ?? process.env;
  }
  get snapshot() {
    return this.store.snapshot();
  }
  private get fetcher() {
    return this.requestFetch ?? globalThis.fetch;
  }
  availableModels() {
    const state = this.snapshot;
    return state.accounts
      .filter((a) => a.id === state.active[a.provider])
      .flatMap((account) =>
        account.models.map((m) => {
          const id = `${account.provider}/${m.id}`;
          return {
            id,
            account: account.name,
            isDefault: id === state.defaultModel,
            billing: billing(account),
          };
        }),
      );
  }
  setDefault(selector: string) {
    const { provider, modelId } = parseSelection(selector);
    this.store.update((state) => {
      const account = state.accounts.find((a) => a.provider === provider && a.id === state.active[provider]);
      if (!account?.models.some((m) => m.id === modelId))
        throw new Error("当前账户未启用该模型，可用模型见 zpi models。");
      state.defaultModel = selector;
    });
  }
  switchAccount(provider: string, name: string) {
    this.store.update((state) => {
      const account = state.accounts.find((a) => a.provider === provider && a.name === name);
      if (!account) throw noAccount();
      state.active[provider] = account.id;
    });
  }

  private readKey(source: Exclude<CredentialSource, { kind: "oauth" }>) {
    if (source.kind === "none") return "";
    const key = source.kind === "env" ? this.env[source.name] : this.secrets.get(source.ref);
    if (!key?.trim() || /[\r\n]/.test(key)) {
      if (source.kind === "env") throw new Error(`请在 shell 中设置已绑定的环境变量 ${source.name}。`);
      throw new Error("CLI 密钥缺失，请用 zpi auth login 重新绑定。");
    }
    return key.trim();
  }
  // Caller holds the named account's lock. Re-read rotation state inside it.
  private async accessToken(ref: string, rejected?: string) {
    let current = savedCredential(this.secrets, ref);
    const save = (next: ChatGPTCredential) => this.secrets.set(ref, JSON.stringify(next));
    if (current.identityPending) {
      current = await verifyRefreshedChatGPTCredential(current, this.fetcher);
      save(current);
    }
    if (current.access && current.access !== rejected && current.expires > Date.now() + 180000)
      return current.access;
    const next = await refreshChatGPTCredential(current, this.fetcher, save);
    save(next);
    return next.access;
  }
  private requestKey(account: Account, modelId: string, rejected?: string): Promise<string> {
    const currentAccount = () => {
      const current = this.snapshot.accounts.find(
        (a) => a.id === account.id && a.provider === account.provider,
      );
      if (!current) throw noAccount();
      if (
        current.baseUrl !== account.baseUrl ||
        current.api !== account.api ||
        !current.models.some((m) => m.id === modelId) ||
        (current.credential.kind === "oauth") !== (account.credential.kind === "oauth")
      )
        throw new Error("当前连接或模型已变更，请用 /model 或 -m 重新选择。");
      return current;
    };
    if (account.credential.kind === "oauth") {
      return this.store.withAccount(account.provider, account.name, async () => {
        const { credential } = currentAccount();
        if (credential.kind !== "oauth") throw noAccount();
        return this.accessToken(credential.ref, rejected);
      });
    }
    const { credential } = currentAccount();
    if (credential.kind === "oauth") throw noAccount();
    return Promise.resolve(this.readKey(credential));
  }
  async selectModel(explicit?: string, previous?: ModelBinding) {
    const state = this.snapshot;
    const pinned = explicit === undefined ? previous : undefined;
    const selector = explicit ?? (pinned ? `${pinned.provider}/${pinned.modelId}` : state.defaultModel);
    if (!selector)
      throw new Error("尚未配置默认模型。请运行 zpi auth login 或 zpi models --default 服务名/模型ID。");
    const { provider, modelId } = parseSelection(selector);
    const account = state.accounts.find(
      (a) => a.provider === provider && a.id === (pinned ? pinned.accountId : state.active[provider]),
    );
    if (!account) throw noAccount();
    const selected = account.models.find((m) => m.id === modelId);
    if (!selected) throw new Error("该账户未启用所选模型，请用 zpi models 查看，或用 -m 明确选择其他模型。");
    // Reconstruct built-ins so a settings file cannot redirect a subscription token.
    const oauth = account.credential.kind === "oauth";
    const [{ runtimeModel, serviceFor }, { ModelRuntime }] = await Promise.all([
      import("./services.ts"),
      import("@zpi-dev/coding-agent"),
    ]);
    const service = serviceFor(provider, oauth ? "oauth" : "key", account);
    const runtime = await ModelRuntime.create({ fetch: this.requestFetch });
    const getApiKey = (rejected?: string) => this.requestKey(account, modelId, rejected);
    await getApiKey();
    runtime.registerProvider(provider, {
      api: service.api,
      baseUrl: service.baseUrl,
      getApiKey,
      models: [runtimeModel(selected, oauth)],
    });
    const model = runtime.getModel(provider, modelId);
    if (!model) throw new Error("无法注册所选模型。");
    return { binding: { provider, modelId, accountId: account.id }, runtime, model };
  }

  private async credentialsForLogin(input: LoginSource, old: Account | undefined, ui: LoginInteraction) {
    if (input.kind === "oauth" && input.reuse && old?.credential.kind === "oauth")
      return { source: old.credential, key: await this.accessToken(old.credential.ref) };
    if (input.kind === "env" || input.kind === "none") {
      const source: CredentialSource =
        input.kind === "none" ? { kind: "none" } : { kind: "env", name: input.name };
      return { source, key: this.readKey(source) };
    }
    const ref = randomUUID();
    if (input.kind === "key") {
      const key = input.value.trim();
      if (!key || /[\r\n]/.test(key)) throw new Error("API key 为空或格式无效。");
      this.secrets.get(ref);
      return { source: { kind: input.kind, ref }, key, secret: key };
    }
    const previous =
      old?.credential.kind === "oauth" ? savedCredential(this.secrets, old.credential.ref) : undefined;
    if (!previous) this.secrets.get(ref); // Check availability before opening the browser.
    const hostId = this.store.update((current) => current.hostId);
    const login = await beginChatGPTLogin({ hostId, credential: previous, fetch: this.fetcher });
    try {
      const url = new URL(login.url);
      if (!previous) url.searchParams.set("agent_name_hint", "ZPI CLI");
      const credential = await ui.authorize({ ...login, url: url.href });
      return {
        source: { kind: input.kind, ref },
        key: credential.access,
        secret: JSON.stringify(credential),
      };
    } finally {
      login.cancel();
    }
  }

  async connect(service: Service, name: string, input: LoginSource, ui: LoginInteraction) {
    const { allowsNoKey, chooseEnabledModels, customAlias, serviceFor, validEnvName, validName } =
      await import("./services.ts");
    if (!validName(name)) throw new Error("请输入有效的账户名称。");
    const oauth = input.kind === "oauth";
    service = serviceFor(service.provider, oauth ? "oauth" : "key", service);
    const { provider } = service;
    return this.store.withAccount(
      provider,
      name,
      async () => {
        const state = this.snapshot;
        const old = state.accounts.find((a) => a.provider === provider && a.name === name);
        if (old && (old.credential.kind === "oauth") !== oauth)
          throw new Error("该账户名已用于另一种计费方式，请输入不同的账户名。");
        if (input.kind === "env" && !validEnvName(input.name)) throw new Error("环境变量名无效。");
        if (input.kind === "none" && !allowsNoKey(service)) throw new Error("此服务需要凭据。");
        const id = old?.id ?? randomUUID();
        const { key, secret, source } = await this.credentialsForLogin(input, old, ui);
        const models = await chooseEnabledModels(
          service,
          key,
          old?.models ?? [],
          input.kind === "oauth" && Boolean(input.reuse),
          ui,
          this.fetcher,
        );
        const ids = models.map((m) => `${provider}/${m.id}`);
        const defaultId =
          !state.defaultModel && ids.length
            ? ids.length === 1
              ? ids[0]
              : await ui.chooseDefault(ids)
            : undefined;
        if (defaultId && !ids.includes(defaultId)) throw new Error("请选择已启用的默认模型。");
        ui.signal?.throwIfAborted();
        const account: Account = { ...service, name, id, credential: source, models };
        if (secret !== undefined && "ref" in source) this.secrets.set(source.ref, secret);
        try {
          this.store.update((current) => {
            const other = current.accounts.filter((a) => a.provider === provider && a.id !== id);
            if (
              customAlias(provider) &&
              other.some((a) => a.api !== service.api || a.baseUrl !== service.baseUrl)
            )
              throw new Error("此服务名已有其他连接。不同地址或协议请使用新的服务名并重新绑定凭据。");
            const index = current.accounts.findIndex((a) => a.id === id);
            if (index >= 0) current.accounts[index] = account;
            else current.accounts.push(account);
            if (!other.length && index < 0) current.active[provider] = id;
            if (!current.defaultModel && defaultId && current.active[provider] === id)
              current.defaultModel = defaultId;
          });
        } catch (error) {
          if (secret !== undefined && "ref" in source) this.secrets.delete(source.ref);
          throw error;
        }
        if (old && "ref" in old.credential && (!("ref" in source) || old.credential.ref !== source.ref))
          this.secrets.delete(old.credential.ref);
        return account;
      },
      ui.signal,
    );
  }
  async logout(id: string) {
    const original = this.snapshot.accounts.find((a) => a.id === id);
    if (!original) throw noAccount();
    return this.store.withAccount(original.provider, original.name, async () => {
      const current = this.snapshot.accounts.find((a) => a.id === id);
      if (!current) throw noAccount();
      let credential: ChatGPTCredential | undefined;
      if (current.credential.kind === "oauth")
        credential = decodeCredential(this.secrets.get(current.credential.ref));
      if ("ref" in current.credential) this.secrets.delete(current.credential.ref);
      this.store.update((state) => {
        state.accounts = state.accounts.filter((a) => a.id !== id);
        if (state.active[current.provider] === id) delete state.active[current.provider];
      });
      if (current.credential.kind === "oauth" && !credential)
        return "本机已退出。原凭据不可用，请在 ChatGPT 设置中断开此 CLI 应用。";
      if (credential) {
        try {
          await revokeChatGPTCredential(credential, this.fetcher);
        } catch {
          return "本机已退出。远端撤销未确认，可在 ChatGPT 设置中断开此 CLI 应用。";
        }
      }
      return undefined;
    });
  }
}
