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
  };
}

test("keeps a separate encrypted web key across restart and chat-provider edits", async () => {
  const f = await fixture();
  const store = f.open();
  expect(store.get().webSearch).toEqual({
    provider: "deepseek",
    hasApiKey: false,
    credentialsPersisted: false,
  });
  store.saveWebSearch({ provider: "deepseek", apiKey: "web-only-fake-key" });
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

test("holds web credentials only in memory without encryption and does not read environment keys", async () => {
  const f = await fixture();
  f.lock();
  const store = f.open();
  expect(store.getWebSearchApiKey()).toBe("");
  store.saveWebSearch({ provider: "deepseek", apiKey: "memory-fake-key" });
  expect(store.get().webSearch).toEqual({
    provider: "deepseek",
    hasApiKey: true,
    credentialsPersisted: false,
  });
  expect(store.getWebSearchApiKey()).toBe("memory-fake-key");
  expect(existsSync(join(f.dir, "credentials.enc"))).toBe(false);
  expect(f.open().getWebSearchApiKey()).toBe("");
  expect(JSON.stringify(f.state.getSetting("app"))).not.toContain("memory-fake-key");
});

test("never overwrites locked encrypted credentials", async () => {
  const f = await fixture();
  f.open().saveWebSearch({ provider: "deepseek", apiKey: "locked-fake-key" });
  const before = await readFile(join(f.dir, "credentials.enc"));
  f.lock();
  const store = f.open();
  expect(() => store.getWebSearchApiKey()).toThrow("尚未解锁");
  expect(() => store.saveWebSearch({ provider: "deepseek", apiKey: "replacement" })).toThrow("尚未解锁");
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(before);
});

test("migrates the absent global capability to false without relaxing strict boolean validation", async () => {
  const f = await fixture();
  f.open().updatePreferences({ theme: "dark" });
  const before = f.state.getSetting<Record<string, unknown>>("app");
  if (!before) throw new Error("Missing settings fixture");
  const capabilities = { ...(before.capabilities as Record<string, unknown>) };
  delete capabilities.webSearch;
  f.state.setSetting("app", { ...before, capabilities });
  expect(f.open().get().capabilities.webSearch).toBe(false);
  expect(f.state.getSetting<{ capabilities: { webSearch: boolean } }>("app")?.capabilities.webSearch).toBe(
    false,
  );
  for (const value of [null, "true", 1]) {
    f.state.setSetting("app", { ...before, capabilities: { ...capabilities, webSearch: value } });
    expect(() => f.open()).toThrow("Invalid plugin capabilities");
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
  ]) {
    expect(() => store.saveWebSearch(value as WebSearchSettingsInput)).toThrow();
    try {
      store.saveWebSearch(value as WebSearchSettingsInput);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
    }
  }
});
