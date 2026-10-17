import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsPage } from "../src/renderer/SettingsPage.tsx";
import { useStore } from "../src/renderer/store.ts";
import type { PublicSettings, Result } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

let root: Root;
let container: HTMLDivElement;
const openQuickChat = vi.fn<() => Promise<Result<void>>>();
const releaseCapture = vi.fn(async () => ({ ok: true as const, value: undefined }));

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
  const settings: PublicSettings = {
    providers: [],
    lastSelection: null,
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
    value: { platform: "darwin", openQuickChat, setShortcutCapture: releaseCapture },
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
