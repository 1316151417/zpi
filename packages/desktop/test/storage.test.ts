import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { StateStore } from "../src/main/state-store.ts";
import { SettingsStore } from "../src/main/storage.ts";
import type { InterfacePreferences } from "../src/shared/bridge.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "zpi-settings-sqlite-"));
  const state = new StateStore(join(dir, "state.sqlite"));
  cleanup.push(async () => {
    state.close();
    await rm(dir, { recursive: true, force: true });
  });
  let available = true;
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
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
const provider = {
  id: "saved",
  name: "Saved",
  baseUrl: "https://example.com/v1",
  models: [{ id: "model" }],
  apiKey: "secret",
};

it("uses SQLite exclusively and never imports or rewrites legacy settings", async () => {
  const f = await fixture();
  const file = join(f.dir, "settings.json");
  await writeFile(file, "{broken old settings");
  const store = f.open();
  expect(store.get().providers).toEqual([]);
  store.updatePreferences({ theme: "dark" });
  expect(f.open().get().interface.theme).toBe("dark");
  expect(await readFile(file, "utf8")).toBe("{broken old settings");
});
it("normalizes saved OpenAI defaults and removes superseded models without changing credentials or custom providers", async () => {
  const f = await fixture();
  const store = f.open();
  store.saveProvider({ ...provider, models: [{ id: "gpt-6-sol", name: "Custom", contextWindow: 272000 }] });
  for (const preset of ["openai-chatgpt", "openai-api"] as const) {
    store.saveProvider({
      id: preset,
      preset,
      name: preset,
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      ...(preset === "openai-api" ? { apiKey: "openai-secret" } : {}),
      models: [
        { id: "gpt-6.1-terra", name: "GPT-6.1-Terra", contextWindow: 1050000 },
        { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", contextWindow: 272000, useRecommendedConfig: false },
        { id: "gpt-6-luna", name: "GPT-6-Luna", contextWindow: 272000, enabled: false },
        { id: "gpt-6-astra", name: "GPT-6-Astra", contextWindow: 400000, useRecommendedConfig: false },
        ...["gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"].map((id) => ({
          id,
          enabled: false,
          useRecommendedConfig: false,
        })),
        { id: "manual-model", name: "Manual", contextWindow: 160000, useRecommendedConfig: false },
      ],
    });
  }
  const credentials = await readFile(join(f.dir, "credentials.enc"));
  const raw = f.state.getSetting<{ providers: { preset?: string; api?: string }[] }>("app");
  if (!raw) throw new Error("Missing settings");
  for (const saved of raw.providers) if (saved.preset === "openai-api") saved.api = "openai-completions";
  f.state.setSetting("app", raw);
  const restored = f.open();
  for (const preset of ["openai-chatgpt", "openai-api"]) {
    const saved = restored.snapshot(preset);
    expect(saved.api).toBe("openai-responses");
    expect(saved.models.map((model) => model.name)).toEqual([
      "GPT-6.1 Terra",
      "GPT-6.1 Sol",
      "GPT-6 Luna",
      "GPT-6 Astra",
      "Manual",
    ]);
    expect(saved.models.map((model) => model.contextWindow)).toEqual([
      500000, 500000, 500000, 400000, 160000,
    ]);
    expect(saved.models[2].enabled).toBe(false);
  }
  expect(restored.snapshot("saved").models).toEqual(store.snapshot("saved").models);
  expect(restored.snapshot("openai-api").apiKey).toBe("openai-secret");
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(credentials);
  const normalized = f.state.getSetting("app");
  expect(f.open().get()).toEqual(restored.get());
  expect(f.state.getSetting("app")).toEqual(normalized);
});
it("locked credential discovery preserves public state and encrypted bytes", async () => {
  const f = await fixture();
  f.open().saveProvider(provider);
  const settings = f.state.getSetting("app");
  const credentials = await readFile(join(f.dir, "credentials.enc"));
  f.lock();
  expect(f.open().discoverEnvironment({ DEEPSEEK_API_KEY: "environment-key" })).toEqual([]);
  expect(f.state.getSetting("app")).toEqual(settings);
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(credentials);
  f.unlock();
  expect(f.open().snapshot("saved").apiKey).toBe("secret");
});
it("persists independent notification and numeric font preferences and rejects invalid updates", async () => {
  const f = await fixture();
  const store = f.open();
  expect(store.get().interface).toMatchObject({
    notificationEnabled: true,
    notificationSoundEnabled: true,
    fontSize: 14,
  });
  store.updatePreferences({ notificationSoundEnabled: false, notificationEnabled: false, fontSize: 20 });
  store.updatePreferences({ notificationEnabled: true });
  expect(f.open().get().interface).toMatchObject({
    notificationEnabled: true,
    notificationSoundEnabled: false,
    fontSize: 20,
  });
  for (const fontSize of [11, 21, 14.5, NaN, Infinity, "large", null]) {
    expect(() => store.updatePreferences({ fontSize } as InterfacePreferences)).toThrow();
    expect(f.open().get().interface.fontSize).toBe(20);
  }
  expect(() =>
    store.updatePreferences({ notificationEnabled: "false" } as unknown as InterfacePreferences),
  ).toThrow();
  expect(() =>
    store.updatePreferences({
      askUserQuestionAutoResolutionEnabled: false,
    } as unknown as InterfacePreferences),
  ).toThrow();
});
it("rejects invalid current settings instead of applying legacy migrations", async () => {
  const f = await fixture();
  f.open().updatePreferences({ theme: "dark" });
  const data = f.state.getSetting<Record<string, unknown>>("app");
  if (!data) throw new Error("missing settings");
  for (const version of [1, 2, 3, 99]) {
    f.state.setSetting("app", { ...data, version });
    expect(() => f.open()).toThrow();
  }
});
it("binds restored credentials to their endpoint and keeps secrets out of SQLite", async () => {
  const f = await fixture();
  const store = f.open();
  store.saveProvider(provider);
  expect(f.open().snapshot("saved").apiKey).toBe("secret");
  const data = f.state.getSetting<{ providers: Record<string, unknown>[] }>("app");
  if (!data) throw new Error("missing settings");
  f.state.setSetting("app", {
    ...data,
    providers: data.providers.map((p) => ({ ...p, baseUrl: "https://other.example/v1" })),
  });
  expect(f.open().get().providers[0].hasApiKey).toBe(false);
  f.lock();
  store.saveProvider({ ...provider, apiKey: "memory-secret" });
  expect(store.snapshot("saved").apiKey).toBe("memory-secret");
  expect(store.get().credentialsPersisted).toBe(false);
  expect(existsSync(join(f.dir, "credentials.enc"))).toBe(false);
  f.unlock();
  expect(f.open().get().providers[0].hasApiKey).toBe(false);
  expect(JSON.stringify(f.state.getSetting("app"))).not.toContain("secret");
  for (const suffix of ["", "-wal"]) {
    const path = join(f.dir, `state.sqlite${suffix}`);
    if (existsSync(path)) expect((await readFile(path)).includes(Buffer.from("memory-secret"))).toBe(false);
  }
});
it("restores credential bytes and public state when the database commit fails", async () => {
  const f = await fixture();
  const store = f.open();
  store.saveProvider(provider);
  const previous = store.get();
  const credentials = await readFile(join(f.dir, "credentials.enc"));
  vi.spyOn(f.state, "setSetting").mockImplementation(() => {
    throw new Error("commit failed");
  });
  expect(() => store.saveProvider({ ...provider, apiKey: "replacement" })).toThrow("commit failed");
  expect(store.get()).toEqual(previous);
  expect(store.snapshot("saved").apiKey).toBe("secret");
  expect(await readFile(join(f.dir, "credentials.enc"))).toEqual(credentials);
});
it("does not close an injected shared database", async () => {
  const f = await fixture();
  f.open().close();
  expect(() => f.state.setSetting("test", true)).not.toThrow();
});
it("closes only its owned connection and permits repeated disposal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-owned-settings-"));
  const store = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  try {
    store.updatePreferences({ theme: "dark" });
    store.close();
    expect(() => store.state.getSetting("app")).toThrow();
    expect(() => store.close()).not.toThrow();
    const reopened = new SettingsStore(dir, {
      isEncryptionAvailable: () => false,
      encryptString: () => Buffer.alloc(0),
      decryptString: () => "",
    });
    try {
      expect(reopened.get().interface.theme).toBe("dark");
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("allows public API and ordinary header configuration while rejecting credential fields", async () => {
  const f = await fixture();
  const publicConfig = {
    api: "openai-responses",
    headers: { "X-Client-Name": "ZPI", Accept: "application/json" },
  };
  f.state.setSetting("public-config", publicConfig);
  expect(f.state.getSetting("public-config")).toEqual(publicConfig);
  for (const secret of [
    { apiKey: "private" },
    { headers: { Authorization: "private" } },
    { refreshToken: "private" },
  ]) {
    expect(() => f.state.setSetting("public-config", secret)).toThrow("credentials");
    expect(f.state.getSetting("public-config")).toEqual(publicConfig);
  }
});

it("persists code preview preferences, accepts older settings and rejects invalid themes or sizes", async () => {
  const f = await fixture();
  const store = f.open();
  const codePreview = {
    lightTheme: "vitesse-light" as const,
    darkTheme: "min-dark" as const,
    fontSizePx: 18,
    showLineNumbers: false,
    wrapLongLines: true,
  };
  store.updatePreferences({ codePreview });
  expect(f.open().get().interface.codePreview).toEqual(codePreview);
  for (const value of [
    { ...codePreview, fontSizePx: 21 },
    { ...codePreview, lightTheme: "unknown" },
    { ...codePreview, wrapLongLines: "yes" },
    { ...codePreview, extra: true },
    null,
  ])
    expect(() => store.updatePreferences({ codePreview: value } as Partial<InterfacePreferences>)).toThrow();
  const saved = f.state.getSetting<{ interface: InterfacePreferences }>("app");
  if (!saved) throw new Error("Missing saved preferences");
  delete saved.interface.codePreview;
  f.state.setSetting("app", saved);
  expect(() => f.open()).not.toThrow();
});
