import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";

it("restores numeric font sizes without changing other settings or rewriting stored data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-font-settings-"));
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
    for (const [pixels, preset] of [
      [12, "small"],
      [13, "small"],
      [14, "default"],
      [15, "default"],
      [16, "large"],
      [17, "large"],
      [20, "large"],
    ]) {
      const raw = JSON.stringify({ ...data, interface: { ...data.interface, fontSize: pixels } });
      await writeFile(file, raw);
      const restored = new SettingsStore(dir, encryption);
      expect(restored.get().interface).toEqual({ ...data.interface, fontSize: preset });
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
  const dir = await mkdtemp(join(tmpdir(), "zpi-storage-"));
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
  const dir = await mkdtemp(join(tmpdir(), "zpi-project-record-"));
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
