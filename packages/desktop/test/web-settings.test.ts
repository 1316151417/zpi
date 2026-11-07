import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { StateStore } from "../src/main/state-store.ts";
import { SettingsStore } from "../src/main/storage.ts";
import type { WebSearchSettingsInput } from "../src/shared/bridge.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-web-settings-"));
  const state = new StateStore(join(dir, "state.sqlite"));
  let available = true;
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString: (s: string) => Buffer.from([...Buffer.from(s)].map((byte) => byte ^ 0xa7)),
    decryptString: (b: Buffer) => Buffer.from([...b].map((byte) => byte ^ 0xa7)).toString(),
  };
  cleanup.push(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    state,
    encryption,
    open: () => new SettingsStore(dir, encryption, state),
    lock: () => {
      available = false;
    },
    unlock: () => {
      available = true;
    },
  };
}
function savedData(state: StateStore) {
  const data = state.getSetting<Record<string, unknown>>("app");
  if (!data) throw new Error("Missing settings fixture");
  return data;
}

test("global search requires an enabled provider and disabling or removing credentials turns it off", async () => {
  const f = await fixture();
  const store = f.open();
  expect(() => store.setPluginEnabled("zpi.web-search", true)).toThrow("请先配置并启用");
  store.saveWebSearch({ provider: "deepseek", apiKey: "fake-search-key" });
  expect(() => store.setPluginEnabled("zpi.web-search", true)).toThrow("请先配置并启用");
  store.saveWebSearch({ provider: "deepseek", enabled: true });
  expect(store.get().plugins.enabled["zpi.web-search"]).toBe(false);
  store.setPluginEnabled("zpi.web-search", true);
  expect(f.open().get().plugins.enabled["zpi.web-search"]).toBe(true);
  store.saveWebSearch({ provider: "deepseek", enabled: false });
  expect(f.open().get().plugins.enabled["zpi.web-search"]).toBe(false);
  store.saveWebSearch({ provider: "deepseek", enabled: true });
  expect(store.get().plugins.enabled["zpi.web-search"]).toBe(false);
  store.setPluginEnabled("zpi.web-search", true);
  store.saveWebSearch({ provider: "deepseek", apiKey: "" });
  expect(f.open().get().plugins.enabled["zpi.web-search"]).toBe(false);
});

test("keeps a separate encrypted web key across restart and chat-provider edits", async () => {
  const f = await fixture();
  const store = f.open();
  expect(store.get().webSearch).toEqual({
    provider: "deepseek",
    enabled: false,
    hasApiKey: false,
    apiKeyLength: 0,
    credentialsPersisted: false,
    credentialsLocked: false,
  });
  expect(store.get().plugins.enabled["zpi.web-search"]).toBe(false);
  store.saveWebSearch({ provider: "deepseek", apiKey: "web-only-fake-key", enabled: true });
  store.saveProvider({
    id: "chat",
    preset: "deepseek",
    name: "DeepSeek Chat",
    baseUrl: "https://api.deepseek.com",
    models: [{ id: "deepseek-chat" }],
    apiKey: "chat-only-fake-key",
  });
  expect(store.getWebSearchApiKey()).toBe("web-only-fake-key");
  store.saveProvider({
    id: "chat",
    name: "Other chat",
    baseUrl: "https://example.com/v1",
    models: [{ id: "other" }],
    apiKey: "other-chat-key",
  });
  expect(f.open().getWebSearchApiKey()).toBe("web-only-fake-key");
  store.deleteProvider("chat");
  expect(f.open().getWebSearchApiKey()).toBe("web-only-fake-key");
  expect(JSON.stringify(store.get())).not.toContain("fake-key");
  expect(JSON.stringify(f.state.getSetting("app"))).not.toMatch(/apiKey|fake-key|web-only/);
  expect((await readFile(join(f.dir, "credentials.enc"))).toString()).not.toContain("fake-key");
  store.saveWebSearch({ provider: "deepseek" });
  expect(store.getWebSearchApiKey()).toBe("web-only-fake-key");
  store.saveWebSearch({ provider: "deepseek", apiKey: "" });
  expect(f.open().get().webSearch.hasApiKey).toBe(false);
});

test("requires a key to enable and never enables a provider by saving or replacing a key", async () => {
  const f = await fixture();
  const store = f.open();
  expect(() => store.saveWebSearch({ provider: "deepseek", enabled: true })).toThrow("请先配置");
  expect(() => store.getWebSearchApiKey()).toThrow("已停用");
  store.saveWebSearch({ provider: "deepseek", apiKey: "saved-fake-key" });
  expect(store.get().webSearch).toMatchObject({ enabled: false, hasApiKey: true });
  expect(() => f.open().getWebSearchApiKey()).toThrow("已停用");
  store.saveWebSearch({ provider: "deepseek", enabled: true });
  expect(f.open().getWebSearchApiKey()).toBe("saved-fake-key");
  const encrypted = await readFile(join(f.dir, "credentials.enc"));
  store.saveWebSearch({ provider: "deepseek", enabled: false });
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(encrypted);
  expect(() => store.getWebSearchApiKey()).toThrow("已停用");
  store.saveWebSearch({ provider: "deepseek", apiKey: "replacement-fake-key" });
  expect(f.open().get().webSearch).toMatchObject({ enabled: false, hasApiKey: true });
  expect(store.get().plugins.enabled["zpi.web-search"]).toBe(false);
  store.setPluginEnabled("zpi.web-search", false);
  store.saveWebSearch({ provider: "deepseek", enabled: true });
  expect(f.open().get()).toMatchObject({
    plugins: { enabled: { "zpi.web-search": false } },
    webSearch: { enabled: true, hasApiKey: true },
  });
  store.setPluginEnabled("zpi.web-search", true);
  expect(f.open().get().webSearch.enabled).toBe(true);
});

test.each([false, true])("reveals only the saved web key with provider enabled=%s", async (enabled) => {
  const f = await fixture();
  const store = f.open();
  const apiKey = "web-reveal-fake-key";
  expect(store.getWebSearchCredentials()).toEqual({ apiKey: "" });
  store.saveWebSearch({ provider: "deepseek", apiKey: `  ${apiKey}  `, enabled });
  const encrypted = await readFile(join(f.dir, "credentials.enc"));
  const publicBefore = store.get();
  for (const current of [store, f.open()]) {
    expect(current.getWebSearchCredentials()).toEqual({ apiKey });
    expect(current.get().webSearch).toEqual({
      provider: "deepseek",
      enabled,
      hasApiKey: true,
      apiKeyLength: apiKey.length,
      credentialsPersisted: true,
      credentialsLocked: false,
    });
    expect(JSON.stringify(current.get())).not.toContain(apiKey);
    expect(current.get().webSearch).not.toHaveProperty("apiKey");
    current.getWebSearchCredentials().apiKey = "changed-fake-key";
    expect(current.getWebSearchCredentials()).toEqual({ apiKey });
    if (!enabled) expect(() => current.getWebSearchApiKey()).toThrow("已停用");
  }
  expect(store.get()).toEqual(publicBefore);
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(encrypted);
  expect(JSON.stringify(savedData(f.state))).not.toContain(apiKey);
  store.saveWebSearch({ provider: "deepseek", apiKey: "" });
  for (const current of [store, f.open()]) {
    expect(current.getWebSearchCredentials()).toEqual({ apiKey: "" });
    expect(current.get().webSearch).toMatchObject({ hasApiKey: false, apiKeyLength: 0 });
  }
});

test("holds web credentials only in memory without encryption and does not read environment keys", async () => {
  const f = await fixture();
  f.lock();
  const store = f.open();
  expect(() => store.getWebSearchApiKey()).toThrow("已停用");
  store.saveWebSearch({ provider: "deepseek", apiKey: "memory-fake-key", enabled: true });
  expect(store.get().webSearch).toEqual({
    provider: "deepseek",
    enabled: true,
    hasApiKey: true,
    apiKeyLength: "memory-fake-key".length,
    credentialsPersisted: false,
    credentialsLocked: false,
  });
  expect(store.getWebSearchApiKey()).toBe("memory-fake-key");
  expect(store.getWebSearchCredentials()).toEqual({ apiKey: "memory-fake-key" });
  expect(existsSync(join(f.dir, "credentials.enc"))).toBe(false);
  expect(f.open().getWebSearchApiKey()).toBe("");
  expect(f.open().getWebSearchCredentials()).toEqual({ apiKey: "" });
  expect(f.open().get().webSearch.apiKeyLength).toBe(0);
  expect(JSON.stringify(f.state.getSetting("app"))).not.toContain("memory-fake-key");
});

test("never overwrites locked encrypted credentials and allows disabling without decrypting", async () => {
  const f = await fixture();
  f.open().saveWebSearch({ provider: "deepseek", apiKey: "locked-fake-key", enabled: true });
  const before = await readFile(join(f.dir, "credentials.enc"));
  f.lock();
  const store = f.open();
  expect(store.get().webSearch).toMatchObject({
    enabled: true,
    hasApiKey: false,
    apiKeyLength: 0,
    credentialsLocked: true,
  });
  const lockedError = new Error("configuration: 保存的联网搜索凭据尚未解锁");
  expect(() => store.getWebSearchCredentials()).toThrow(lockedError);
  expect(() => store.getWebSearchApiKey()).toThrow("尚未解锁");
  expect(() => store.saveWebSearch({ provider: "deepseek", apiKey: "replacement" })).toThrow("尚未解锁");
  store.saveWebSearch({ provider: "deepseek", enabled: false });
  expect(() => store.getWebSearchCredentials()).toThrow(lockedError);
  expect(() => f.open().getWebSearchCredentials()).toThrow(lockedError);
  expect(() => store.saveWebSearch({ provider: "deepseek", enabled: true })).toThrow("尚未解锁");
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(before);
  f.unlock();
  expect(f.open().get().webSearch).toMatchObject({
    enabled: false,
    hasApiKey: true,
    credentialsLocked: false,
  });
  expect(() => f.open().getWebSearchApiKey()).toThrow("已停用");
  expect(f.open().getWebSearchCredentials()).toEqual({ apiKey: "locked-fake-key" });
  expect(f.open().get().webSearch.apiKeyLength).toBe("locked-fake-key".length);
});

test("rejects invalid persisted provider states", async () => {
  const f = await fixture();
  f.open().updatePreferences({ theme: "dark" });
  const before = savedData(f.state);
  for (const value of [null, "true", 1, {}]) {
    f.state.setSetting("app", { ...before, webSearchEnabled: value });
    expect(() => f.open()).toThrow("Invalid web search provider state");
  }
});

test("rejects untrusted settings shapes without reflecting key text", async () => {
  const f = await fixture();
  const store = f.open();
  for (const value of [
    null,
    { provider: "other" },
    { provider: "deepseek", apiKey: 1 },
    { provider: "deepseek", apiKey: "secret\nheader" },
    { provider: "deepseek", baseUrl: "https://untrusted.example" },
    { provider: "deepseek", enabled: "true" },
    { provider: "deepseek", enabled: null },
  ]) {
    expect(() => store.saveWebSearch(value as WebSearchSettingsInput)).toThrow();
    try {
      store.saveWebSearch(value as WebSearchSettingsInput);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }
});
