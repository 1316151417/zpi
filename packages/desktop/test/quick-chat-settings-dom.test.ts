import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsPage } from "../src/renderer/SettingsPage.tsx";
import { useStore } from "../src/renderer/store.ts";
import type { PublicSettings, QuickChatSettingsInput, Result } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

let root: Root;
let container: HTMLDivElement;
const openQuickChat = vi.fn<() => Promise<Result<void>>>();
const saveQuickChatSettings = vi.fn<(input: QuickChatSettingsInput) => Promise<Result<PublicSettings>>>();
const releaseCapture = vi.fn(async () => ({ ok: true as const, value: undefined }));

function currentSettings(): PublicSettings {
  const settings = useStore.getState().settings;
  if (!settings) throw new Error("Missing settings");
  return settings;
}
function query<T extends Element>(selector: string): T {
  const element = container.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
}
function button(text: string): HTMLButtonElement {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === text);
  expect(element, text).toBeDefined();
  return element as HTMLButtonElement;
}
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  openQuickChat.mockReset().mockResolvedValue({ ok: true, value: undefined });
  releaseCapture.mockClear();
  saveQuickChatSettings.mockReset().mockImplementation(async (quickChat) => ({
    ok: true,
    value: { ...currentSettings(), quickChat },
  }));
  const settings: PublicSettings = {
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
  useStore.setState({ settings });
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: { platform: "darwin", openQuickChat, saveQuickChatSettings, setShortcutCapture: releaseCapture },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(SettingsPage, { onClose: vi.fn() })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("navigates from the real settings sidebar to quick chat and the existing shortcut editor", async () => {
  const tabs = [...container.querySelectorAll<HTMLButtonElement>(".settings-tabs button")];
  const labels = tabs.map((item) => item.getAttribute("aria-label"));
  expect(labels.indexOf("快速对话")).toBe(labels.indexOf("子智能体") + 1);
  await click(query('button[aria-label="快速对话"]'));
  expect(query('button[aria-label="快速对话"]').getAttribute("aria-pressed")).toBe("true");
  expect(query('section[aria-label="快速对话设置"]').textContent).toContain("⌥N");
  expect(container.textContent).toContain("临时对话，不保存到任务列表");
  expect(container.textContent).toContain("可用 read、bash 及已启用的联网工具");
  expect(container.textContent).toContain("只读要求依赖提示词，bash 仍可读写本机文件");
  expect(container.textContent).not.toContain("工具仅允许只读");
  expect(button("修改快捷键").classList.contains("settings-action-button")).toBe(true);
  await click(button("修改快捷键"));
  expect(query('button[aria-label="快捷键"]').getAttribute("aria-pressed")).toBe("true");
  expect(query(".shortcut-settings h1").textContent).toBe("键盘快捷键");
  const row = query('[data-shortcut-command="quick-chat"]');
  expect(row.textContent).toContain("快速对话");
  expect(row.querySelector('button[aria-label="录入快速对话快捷键"]')).not.toBeNull();
  expect(openQuickChat).not.toHaveBeenCalled();
  await click(query('button[aria-label="快速对话"]'));
  expect(releaseCapture).toHaveBeenCalledWith(false);
  expect(query('section[aria-label="快速对话设置"]')).not.toBeNull();
});

test("disables repeated open clicks while pending, reports failure, and allows a successful retry", async () => {
  let resolve!: (result: Result<void>) => void;
  openQuickChat.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    }),
  );
  await click(query('button[aria-label="快速对话"]'));
  await act(async () => {
    const open = button("打开快速对话");
    open.click();
    open.click();
  });
  expect(openQuickChat).toHaveBeenCalledOnce();
  expect(button("打开中…").disabled).toBe(true);
  await act(async () => {
    resolve({ ok: false, error: { code: "configuration", message: "无法创建窗口" } });
  });
  expect(query('[role="alert"]').textContent).toContain("无法创建窗口");
  expect(button("打开快速对话").disabled).toBe(false);
  await click(button("打开快速对话"));
  expect(openQuickChat).toHaveBeenCalledTimes(2);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(button("打开快速对话").disabled).toBe(false);
});

async function configureModels() {
  await act(async () => {
    const settings = useStore.getState().settings;
    if (!settings) throw new Error("Missing settings");
    useStore.setState({
      settings: {
        ...settings,
        lastSelection: { provider: "chat", modelId: "first", reasoning: "none" },
        providers: [
          {
            id: "chat",
            name: "Chat",
            baseUrl: "https://example.com/v1",
            hasApiKey: true,
            models: [
              { id: "first", reasoning: false },
              { id: "second", reasoning: true },
            ],
          },
        ],
      },
    });
  });
  await click(query('button[aria-label="快速对话"]'));
}
async function choose(label: string, value: string) {
  await act(async () => {
    query<HTMLElement>(`button[aria-label="${label}"]`).dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (item) => item.textContent === value,
  );
  expect(option, value).toBeDefined();
  if (!option) throw new Error(`Missing option ${value}`);
  await click(option);
}

test("saves the model and reasoning through real select events without changing the main task selection", async () => {
  await configureModels();
  expect(container.textContent).toContain("当前自动使用：Chat · first");
  await choose("快速对话默认模型", "Chat · second");
  expect(saveQuickChatSettings).toHaveBeenCalledWith({
    defaultSelection: { provider: "chat", modelId: "second", reasoning: "medium" },
  });
  expect(query('button[aria-label="快速对话默认模型"]').textContent).toContain("Chat · second");
  expect(query('button[aria-label="快速对话思考级别"]').textContent).toContain("中");
  await choose("快速对话思考级别", "高");
  expect(saveQuickChatSettings).toHaveBeenLastCalledWith({
    defaultSelection: { provider: "chat", modelId: "second", reasoning: "high" },
  });
  expect(useStore.getState().settings?.lastSelection).toEqual({
    provider: "chat",
    modelId: "first",
    reasoning: "none",
  });
  await choose("快速对话默认模型", "自动选择首个可用模型");
  expect(saveQuickChatSettings).toHaveBeenLastCalledWith({ defaultSelection: null });
  expect(container.querySelector('button[aria-label="快速对话思考级别"]')).toBeNull();
});

test("keeps the selected model after a rejected save, disables pending edits and permits retry", async () => {
  await configureModels();
  let finish!: (result: Result<PublicSettings>) => void;
  saveQuickChatSettings.mockReturnValueOnce(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await choose("快速对话默认模型", "Chat · second");
  expect(query<HTMLButtonElement>('button[aria-label="快速对话默认模型"]').disabled).toBe(true);
  expect(query('button[aria-label="快速对话默认模型"]').textContent).toContain("自动选择首个可用模型");
  expect(button("修改快捷键").disabled).toBe(true);
  await act(async () => {
    finish({ ok: false, error: { code: "storage", message: "disk full" } });
  });
  expect(query('[role="alert"]').textContent).toContain("原设置未更改");
  expect(query<HTMLButtonElement>('button[aria-label="快速对话默认模型"]').disabled).toBe(false);
  expect(useStore.getState().settings?.quickChat.defaultSelection).toBeNull();
  await choose("快速对话默认模型", "Chat · second");
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(query('button[aria-label="快速对话默认模型"]').textContent).toContain("Chat · second");
});

test("explains an invalid default and disables selection when every model is unavailable", async () => {
  await configureModels();
  await act(async () => {
    const settings = currentSettings();
    useStore.setState({
      settings: {
        ...settings,
        quickChat: { defaultSelection: { provider: "chat", modelId: "missing", reasoning: "high" } },
      },
    });
  });
  expect(container.textContent).toContain("原默认配置已不可用");
  expect(container.textContent).toContain("当前自动使用：Chat · first");
  await act(async () => {
    const settings = currentSettings();
    useStore.setState({
      settings: {
        ...settings,
        providers: settings.providers.map((provider) => ({ ...provider, enabled: false })),
      },
    });
  });
  expect(container.textContent).toContain("暂无可用模型，请先在「模型」设置中添加并启用模型。");
  expect(query<HTMLButtonElement>('button[aria-label="快速对话默认模型"]').disabled).toBe(true);
  expect(saveQuickChatSettings).not.toHaveBeenCalled();
});

test("keeps an acknowledged default when leaving and returning to the settings page", async () => {
  await configureModels();
  await choose("快速对话默认模型", "Chat · second");
  await click(button("修改快捷键"));
  expect(container.querySelector('section[aria-label="快速对话设置"]')).toBeNull();
  await click(query('button[aria-label="快速对话"]'));
  expect(query('button[aria-label="快速对话默认模型"]').textContent).toContain("Chat · second");
  expect(query('button[aria-label="快速对话思考级别"]').textContent).toContain("中");
  expect(saveQuickChatSettings).toHaveBeenCalledOnce();
});

test("displays a valid saved reasoning level even when equivalent choices are deduplicated", async () => {
  await configureModels();
  await act(async () => {
    const settings = currentSettings();
    useStore.setState({
      settings: {
        ...settings,
        providers: [
          {
            ...settings.providers[0],
            models: [
              {
                id: "second",
                reasoning: true,
                defaultThinkingLevel: "medium",
                compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
              },
            ],
          },
        ],
        quickChat: { defaultSelection: { provider: "chat", modelId: "second", reasoning: "medium" } },
      },
    });
  });
  expect(query('button[aria-label="快速对话思考级别"]').textContent).toContain("中");
  expect(container.textContent).not.toContain("原默认配置已不可用");
  expect(saveQuickChatSettings).not.toHaveBeenCalled();
});
