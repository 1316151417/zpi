import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fetchProviderModels, presetModels } from "zpi-ai";
import { SettingsPage } from "../src/renderer/SettingsPage.tsx";
import { useStore } from "../src/renderer/store.ts";
import type { DesktopBridge, PublicSettings } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";
import { emptyTaskGroups } from "../src/shared/task-groups.ts";

let root: Root;
let container: HTMLDivElement;
let settings: PublicSettings;
const discoverModels = vi.fn<DesktopBridge["discoverModels"]>();
const saveProvider = vi.fn<DesktopBridge["saveProvider"]>();
const query = <T extends Element>(selector: string): T => {
  const element = container.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
};
const button = (text: string) => {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  expect(element, text).toBeDefined();
  return element as HTMLButtonElement;
};
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
async function chooseApi(label: string) {
  await act(async () => {
    query<HTMLElement>('[aria-label="API 格式"]').dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const options = [...document.querySelectorAll<HTMLElement>('[role="option"]')];
  expect(options.map((option) => option.textContent)).toEqual([
    "OpenAI Responses (/responses)",
    "OpenAI Chat Completions (/chat/completions)",
  ]);
  const option = options.find((option) => option.textContent === label);
  if (!option) throw new Error(`Missing API option ${label}`);
  await click(option);
}
async function fillApiKey() {
  await act(async () => {
    const key = query<HTMLInputElement>("#model-provider-api-key");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(key, "fake-api-key");
    key.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = {
    providers: [],
    lastSelection: null,
    quickChat: { defaultSelection: null },
    interface: defaultPreferences,
    shortcuts: defaultShortcuts("darwin"),
    capabilities: defaultCapabilities,
    credentialsPersisted: false,
    disabledSkillPaths: [],
    webSearch: {
      provider: "deepseek",
      enabled: false,
      hasApiKey: false,
      apiKeyLength: 0,
      credentialsPersisted: false,
      credentialsLocked: false,
    },
  };
  discoverModels.mockReset();
  saveProvider.mockReset().mockImplementation(async ({ apiKey: _, ...provider }) => {
    settings = { ...settings, providers: [{ ...provider, id: "openai", hasApiKey: true }] };
    return { ok: true, value: settings };
  });
  useStore.setState({ settings, sessions: new Map(), selected: undefined });
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      platform: "darwin",
      discoverModels,
      saveProvider,
      getProviderCredentials: async () => ({ ok: true, value: { apiKey: "fake-api-key" } }),
      getSettings: async () => ({ ok: true, value: settings }),
      listProjects: async () => ({ ok: true, value: [] }),
      listRecentSessions: async () => ({ ok: true, value: [] }),
      getTaskGroups: async () => ({ ok: true, value: emptyTaskGroups() }),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(SettingsPage, { onClose: vi.fn() })));
  await click(query('button[aria-label="模型"]'));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test.each([true, false])(
  "adds OpenAI API with only a key and keeps four models when discovery succeeds=%s",
  async (online) => {
    discoverModels.mockImplementation(async (input) => ({
      ok: true,
      value: await fetchProviderModels({ ...input, apiKey: input.apiKey ?? "" }, async () =>
        online ? Response.json({ data: [{ id: "gpt-6.1-sol" }] }) : new Response(null, { status: 503 }),
      ),
    }));
    expect(button("OpenAI（ChatGPT）")).toBeDefined();
    await click(button("OpenAI（API）"));
    expect(container.querySelector('input[aria-label="Base URL"]')).toBeNull();
    expect(container.querySelector('input[aria-label="提供商名称"]')).toBeNull();
    expect(query<HTMLButtonElement>('[aria-label="API 格式"]').disabled).toBe(false);
    expect(query('[aria-label="API 格式"]').textContent).toContain("OpenAI Responses");
    expect(container.querySelectorAll(".provider-connection-fields input")).toHaveLength(1);
    const ids = presetModels("openai-chatgpt").map((model) => model.id);
    expect(
      [...container.querySelectorAll("[data-model-id]")].map((row) => row.getAttribute("data-model-id")),
    ).toEqual(ids);
    expect(button("保存提供商").disabled).toBe(true);
    await fillApiKey();
    await click(button("保存提供商"));
    expect(discoverModels).toHaveBeenCalledExactlyOnceWith({
      preset: "openai-api",
      api: "openai-responses",
      apiKey: "fake-api-key",
    });
    expect(saveProvider).toHaveBeenCalledOnce();
    expect(saveProvider.mock.calls[0][0]).toMatchObject({
      preset: "openai-api",
      name: "OpenAI（API）",
      baseUrl: "https://api.openai.com/v1",
      api: "openai-responses",
      apiKey: "fake-api-key",
    });
    expect(settings.providers[0].models.map((model) => model.id)).toEqual(ids);
    expect(query('.provider-footer [role="status"]').textContent).toContain(
      online ? "账号可用性待验证" : "在线模型列表暂不可用",
    );
    await click(query('button[aria-label="获取模型"]'));
    expect(discoverModels).toHaveBeenLastCalledWith({
      preset: "openai-api",
      api: "openai-responses",
      apiKey: "fake-api-key",
      providerId: "openai",
    });
  },
);

test("switches OpenAI API protocols in both directions and restores the saved choice with its key and models", async () => {
  discoverModels.mockResolvedValue({
    ok: true,
    value: { models: presetModels("openai-api"), source: "remote" },
  });
  await click(button("OpenAI（API）"));
  await fillApiKey();
  const formats = [
    ["OpenAI Chat Completions (/chat/completions)", "openai-completions"],
    ["OpenAI Responses (/responses)", "openai-responses"],
  ] as const;
  for (const [label, api] of formats) {
    await chooseApi(label);
    expect(query<HTMLInputElement>("#model-provider-api-key").value).toBe("fake-api-key");
    await click(button("保存提供商"));
    expect(saveProvider.mock.calls.at(-1)?.[0]).toMatchObject({
      api,
      baseUrl: "https://api.openai.com/v1",
      apiKey: "fake-api-key",
    });
    expect(settings.providers[0].models.map((model) => model.id)).toEqual(
      presetModels("openai-api").map((model) => model.id),
    );
    await act(async () => {
      root.unmount();
      root = createRoot(container);
      root.render(createElement(SettingsPage, { onClose: vi.fn() }));
    });
    await click(query('button[aria-label="模型"]'));
    expect(query('[aria-label="API 格式"]').textContent).toBe(label);
    expect(query<HTMLInputElement>("#model-provider-api-key").value).toBe("fake-api-key");
  }
  await act(async () => query<HTMLButtonElement>('[aria-label="API 格式说明"]').focus());
  expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(
    "部分模型的工具调用仅支持 Responses",
  );
});
