import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import type { InterfacePreferences } from "../src/shared/bridge.ts";

it("notification preferences default on, migrate old settings and preserve the independent sound choice", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-notification-settings-"));
  const encryption = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  try {
    const store = new SettingsStore(dir, encryption);
    expect(store.get().interface).toMatchObject({
      notificationEnabled: true,
      notificationSoundEnabled: true,
    });
    store.updatePreferences({ notificationSoundEnabled: false });
    store.updatePreferences({ notificationEnabled: false });
    store.updatePreferences({ notificationEnabled: true });
    expect(new SettingsStore(dir, encryption).get().interface).toMatchObject({
      notificationEnabled: true,
      notificationSoundEnabled: false,
    });
    for (const key of ["notificationEnabled", "notificationSoundEnabled"]) {
      expect(() => store.updatePreferences({ [key]: "false" } as unknown as InterfacePreferences)).toThrow(
        "无效界面设置",
      );
    }
    const file = join(dir, "settings.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    delete data.interface.notificationEnabled;
    delete data.interface.notificationSoundEnabled;
    const original = JSON.stringify(data);
    await writeFile(file, original);
    expect(new SettingsStore(dir, encryption).get().interface).toMatchObject({
      notificationEnabled: true,
      notificationSoundEnabled: true,
    });
    expect(await readFile(file, "utf8")).toBe(original);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("pixel font sizes persist and invalid updates leave settings intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-font-size-"));
  const encryption = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  try {
    const store = new SettingsStore(dir, encryption);
    expect(store.get().interface.fontSize).toBe(14);
    for (const fontSize of [12, 15, 20]) {
      store.updatePreferences({ fontSize });
      expect(new SettingsStore(dir, encryption).get().interface.fontSize).toBe(fontSize);
    }
    for (const fontSize of [11, 21, 14.5, NaN, Infinity, "large", null]) {
      expect(() => store.updatePreferences({ fontSize } as InterfacePreferences)).toThrow(
        /Invalid interface preferences|无效界面设置/,
      );
      expect(store.get().interface.fontSize).toBe(20);
      expect(new SettingsStore(dir, encryption).get().interface.fontSize).toBe(20);
    }
    const file = join(dir, "settings.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    // Migration changes only settings; locked credentials must remain byte-for-byte intact.
    const credentialFile = join(dir, "credentials.enc");
    await writeFile(credentialFile, "locked credentials");
    for (const [legacy, fontSize] of [
      ["small", 12],
      ["default", 14],
      ["large", 16],
    ]) {
      await writeFile(file, JSON.stringify({ ...data, interface: { ...data.interface, fontSize: legacy } }));
      expect(new SettingsStore(dir, encryption).get().interface.fontSize).toBe(fontSize);
      expect(JSON.parse(await readFile(file, "utf8")).interface.fontSize).toBe(fontSize);
      expect(await readFile(credentialFile, "utf8")).toBe("locked credentials");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("restores numeric font sizes without changing other settings or rewriting stored data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-font-settings-"));
  const encryption = {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  };
  try {
    const store = new SettingsStore(dir, encryption);
    store.updatePreferences({ theme: "dark", sidebarWidth: 200, collapsedProjectIds: ["my-project"] });
    const file = join(dir, "settings.json");
    const data = JSON.parse(await readFile(file, "utf8"));
    for (const pixels of [12, 13, 14, 15, 16, 17, 20]) {
      const raw = JSON.stringify({ ...data, interface: { ...data.interface, fontSize: pixels } });
      await writeFile(file, raw);
      const restored = new SettingsStore(dir, encryption);
      expect(restored.get().interface).toEqual({ ...data.interface, fontSize: pixels });
      expect(await readFile(file, "utf8")).toBe(raw);
    }
    for (const fontSize of [11, 21, 14.5, "14"]) {
      await writeFile(file, JSON.stringify({ ...data, interface: { ...data.interface, fontSize } }));
      expect(() => new SettingsStore(dir, encryption)).toThrow("无效界面设置");
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("credential restore is bound to the endpoint and unavailable encryption removes stale credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-storage-"));
  let available = true;
  // A deterministic codec tests persistence without using the machine's keychain.
  const encryption = {
    isEncryptionAvailable: () => available,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const input = {
    baseUrl: "http://127.0.0.1:8000/v1",
    modelId: "fake",
    apiKey: "first-secret",
    headers: { "X-Auth": "header-secret" },
    supportsImages: false,
    reasoning: false,
    contextWindow: 32768,
    maxTokens: 4096,
  };
  try {
    const store = new SettingsStore(dir, encryption);
    store.save(input);
    expect(new SettingsStore(dir, encryption).snapshot().apiKey).toBe("first-secret");
    const settings = JSON.parse(await readFile(join(dir, "settings.json"), "utf8"));
    await writeFile(
      join(dir, "settings.json"),
      JSON.stringify({
        ...settings,
        providers: settings.providers.map((p: Record<string, unknown>) => ({
          ...p,
          baseUrl: "http://127.0.0.1:9000/v1",
        })),
      }),
    );
    expect(new SettingsStore(dir, encryption).get().providers[0].hasApiKey).toBe(false);
    available = false;
    store.save({ ...input, apiKey: "memory-secret" });
    expect(store.snapshot().apiKey).toBe("memory-secret");
    expect(store.get().credentialsPersisted).toBe(false);
    expect(existsSync(join(dir, "credentials.enc"))).toBe(false);
    available = true;
    expect(new SettingsStore(dir, encryption).get().providers[0].hasApiKey).toBe(false);
    expect(await readFile(join(dir, "settings.json"), "utf8")).not.toContain("secret");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("project files are validated before their IDs can become storage paths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-project-record-"));
  const settings = new SettingsStore(dir, {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  try {
    const record = { id: "../outside", name: "Bad", path: dir, updatedAt: Date.now() };
    await writeFile(join(dir, "projects.json"), JSON.stringify([record]));
    expect(() => new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined, [])).toThrow(
      "storage: Invalid project records",
    );
    await writeFile(join(dir, "projects.json"), JSON.stringify([{ ...record, id: "valid" }]));
    expect(
      new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined, []).listProjects(),
    ).toHaveLength(1);
    await writeFile(
      join(dir, "projects.json"),
      JSON.stringify([
        { ...record, id: "valid" },
        { ...record, id: "valid" },
      ]),
    );
    expect(() => new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined, [])).toThrow(
      "storage: Duplicate project records",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
