import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import type * as Keyring from "@napi-rs/keyring";
import type { DiscoveredModel, ProviderApi, ProviderPresetId } from "@zpi-dev/ai";

export interface Service {
  provider: string;
  api: ProviderApi;
  baseUrl: string;
  preset?: ProviderPresetId;
}
export type CredentialSource =
  | { kind: "oauth"; ref: string }
  | { kind: "key"; ref: string }
  | { kind: "env"; name: string }
  | { kind: "none" };
export interface Account extends Service {
  id: string;
  name: string;
  credential: CredentialSource;
  models: DiscoveredModel[];
}
export function validModelId(value: string) {
  return value.length > 0 && value.length <= 200 && !/[\p{C}\s]/u.test(value);
}
export function billing(account: Account) {
  if (account.credential.kind === "oauth") return "ChatGPT 订阅";
  return account.credential.kind === "none" ? "无密钥" : "API";
}
interface AccountState {
  version: 1;
  hostId: string;
  accounts: Account[];
  active: Record<string, string>;
  defaultModel?: string;
}
export interface SecretStore {
  get(ref: string): string | null;
  set(ref: string, value: string): void;
  delete(ref: string): void;
}

// Load the native addon only for connections which actually use an OS credential store.
const require = createRequire(import.meta.url);
function keyring<T>(ref: string, use: (entry: Keyring.Entry) => T): T {
  try {
    const { Entry } = require("@napi-rs/keyring") as typeof Keyring;
    return use(new Entry("dev.zpi.cli", ref, { linux: { store: "secret-service" } }));
  } catch {
    throw new Error(
      "CLI 系统密钥库不可用。请解锁 Keychain 或启用 Secret Service。API 服务也可绑定环境变量。",
    );
  }
}
export const systemSecrets: SecretStore = {
  get: (ref) => keyring(ref, (entry) => entry.getPassword()),
  set: (ref, value) => keyring(ref, (entry) => entry.setPassword(value)),
  delete: (ref) => keyring(ref, (entry) => entry.deleteCredential()),
};

function openDatabase(path: string) {
  const db = new DatabaseSync(path);
  chmodSync(path, 0o600);
  return db;
}

export class AccountStore {
  readonly root: string;
  constructor(root: string) {
    this.root = root;
  }
  private access<T>(update: boolean, read: (state: AccountState) => T): T {
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
    const db = openDatabase(join(this.root, "accounts.sqlite"));
    try {
      db.exec(
        "PRAGMA busy_timeout=3000; CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK (id = 1), data TEXT NOT NULL)",
      );
      if (update) db.exec("BEGIN IMMEDIATE");
      const row = db.prepare("SELECT data FROM settings WHERE id=1").get();
      const state: AccountState = row
        ? JSON.parse(String(row.data))
        : { version: 1, hostId: `urn:uuid:${randomUUID()}`, accounts: [], active: {} };
      if (state.version !== 1 || !Array.isArray(state.accounts))
        throw new Error("无法读取 CLI 账户配置版本。");
      const result = read(state);
      if (update) {
        db.prepare("INSERT OR REPLACE INTO settings(id,data) VALUES(1,?)").run(JSON.stringify(state));
        db.exec("COMMIT");
      }
      return result;
    } finally {
      db.close();
    }
  }
  snapshot() {
    return this.access(false, (state) => state);
  }
  update<T>(edit: (state: AccountState) => T) {
    return this.access(true, edit);
  }
  // Each account has a kernel-released advisory lock. Independent accounts and
  // ordinary reads stay available while a browser login or token rotation waits.
  async withAccount<T>(provider: string, name: string, action: () => Promise<T>, signal?: AbortSignal) {
    const directory = join(this.root, "account-locks");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const id = createHash("sha256")
      .update(JSON.stringify([provider, name]))
      .digest("hex");
    const db = openDatabase(join(directory, `${id}.sqlite`));
    try {
      const until = Date.now() + 30000;
      for (;;) {
        signal?.throwIfAborted();
        try {
          db.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (!(error instanceof Error) || !("errcode" in error) || error.errcode !== 5) throw error;
          if (Date.now() >= until) throw new Error("该账户正在其他终端登录或刷新，请稍后重试。");
          await delay(40, undefined, { signal });
        }
      }
      return await action();
    } finally {
      db.close();
    }
  }
}
