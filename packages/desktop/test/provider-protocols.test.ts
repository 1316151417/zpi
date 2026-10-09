import { presetModels, providerApi, providerApis, providerBaseUrl, providerPresets } from "ZPI-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SettingsStore } from "../src/main/storage.ts";
import { draftModel, serializeModel } from "../src/renderer/ModelConfigDialog.tsx";
import { availablePresets } from "../src/shared/config.ts";

const codec = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};

it("persists each preset's Anthropic and OpenAI connection without losing its credentials or models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-protocols-"));
  try {
    let settings = new SettingsStore(dir, codec);
    for (const preset of providerPresets.filter((preset) => preset.id !== "openai-chatgpt")) {
      expect(providerApi(preset.id)).toBe("anthropic-messages");
      for (const api of providerApis(preset.id)) {
        settings.saveProvider({
          id: preset.id,
          preset: preset.id,
          name: preset.name,
          api,
          baseUrl: providerBaseUrl(preset.id, api),
          apiKey: "test-secret",
          models: presetModels(preset.id, api).map((model) => serializeModel(draftModel(model))),
        });
        settings = new SettingsStore(dir, codec);
        const saved = settings.snapshot(preset.id);
        expect(saved.api).toBe(api);
        expect(saved.apiKey).toBe("test-secret");
        const model = settings.getModel({ provider: preset.id, modelId: saved.models[0].id });
        expect(model?.api).toBe(api);
        expect(model?.baseUrl).toBe(providerBaseUrl(preset.id, api));
        expect(model).toBeDefined();
        if (model) expect(availablePresets(model)).not.toHaveLength(0);
      }
    }
    expect(() =>
      settings.saveProvider({ ...settings.snapshot("mimo-api"), api: "openai-responses" }),
    ).toThrow("不支持的 API 格式");
    expect(() =>
      settings.saveProvider({ ...settings.snapshot("mimo-api"), api: "anthropic-messages" }),
    ).toThrow("地址不匹配");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps existing protocol-less records on Chat Completions and imports new environment connections as Anthropic", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-legacy-protocol-"));
  try {
    let settings = new SettingsStore(dir, codec);
    settings.saveProvider({
      id: "legacy",
      preset: "deepseek",
      name: "Legacy",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test-secret",
      models: [{ id: "deepseek-flash", reasoning: false }],
    });
    settings = new SettingsStore(dir, codec);
    expect(settings.getModel({ provider: "legacy", modelId: "deepseek-flash" })?.api).toBe(
      "openai-completions",
    );
    settings.discoverEnvironment({ MIMO_API_KEY: "env-secret" });
    expect(settings.snapshot("env-mimo-coding")).toMatchObject({
      api: "anthropic-messages",
      baseUrl: "https://token-plan-cn.xiaomimimo.com/anthropic",
      apiKey: "env-secret",
    });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
