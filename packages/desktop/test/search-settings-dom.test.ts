import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SettingsPage } from "../src/renderer/SettingsPage.tsx";
import { useStore } from "../src/renderer/store.ts";
import { TaskSearchDialog } from "../src/renderer/TaskSearchDialog.tsx";
import type { PublicSettings } from "../src/shared/bridge.ts";
import { defaultCapabilities, defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";

let root: Root;
let container: HTMLDivElement;
const searchTasks = vi.fn();
const saveProvider = vi.fn();
const click = (element: HTMLElement) => act(async () => element.click());
const button = (text: string) => {
  const element = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === text,
  );
  expect(element, text).toBeDefined();
  return element as HTMLButtonElement;
};
const pressEscape = (element: Element) =>
  act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  });
function query<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  expect(element, selector).not.toBeNull();
  return element as T;
}
async function fill(label: string, text: string) {
  const input = query<HTMLInputElement>(`input[aria-label="${label}"]`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const settings: PublicSettings = {
    providers: ["first", "second"].map((id) => ({
      id,
      name: id,
      baseUrl: `https://${id}.invalid/v1`,
      api: "openai-completions",
      hasApiKey: true,
      models: [{ id: "fake", reasoning: false }],
    })),
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
  useStore.setState({
    settings,
    sessions: new Map([["task", { id: "task", title: "Task", projectId: null, createdAt: 0, updatedAt: 0 }]]),
  });
  searchTasks.mockReset().mockResolvedValue({ ok: true, value: [] });
  saveProvider.mockReset();
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      platform: "darwin",
      searchTasks,
      saveProvider,
      getProviderCredentials: async (id: string) => ({ ok: true, value: { apiKey: `${id}-key` } }),
      searchWorkspaceFiles: async () => ({
        ok: true,
        value: { entries: [], truncated: false, incomplete: false },
      }),
      cancelWorkspaceFileSearch: async () => ({ ok: true, value: undefined }),
      listProjects: async () => ({ ok: true, value: [] }),
      listRecentSessions: async () => ({ ok: true, value: [] }),
      getSettings: async () => ({ ok: true, value: useStore.getState().settings }),
      getTaskGroups: async () => ({ ok: true, value: { version: 1, groups: [], roots: [], members: {} } }),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("task search debounces typing and ignores streaming task timestamps", async () => {
  vi.useFakeTimers();
  await act(async () =>
    root.render(
      createElement(TaskSearchDialog, {
        workspaceKey: "ZPI",
        projects: [],
        commands: [],
        onClose: vi.fn(),
        onSelectTask: vi.fn(),
        onOpenFile: vi.fn(),
      }),
    ),
  );
  await act(async () => vi.advanceTimersByTimeAsync(1));
  searchTasks.mockClear();
  await fill("搜索操作、任务或文件", "n");
  await act(async () => vi.advanceTimersByTimeAsync(100));
  await fill("搜索操作、任务或文件", "needle");
  await act(async () => {
    const task = useStore.getState().sessions.get("task");
    if (task) useStore.setState({ sessions: new Map([[task.id, { ...task, updatedAt: 1 }]]) });
    await vi.advanceTimersByTimeAsync(199);
  });
  expect(searchTasks).not.toHaveBeenCalled();
  await act(async () => vi.advanceTimersByTimeAsync(1));
  expect(searchTasks).toHaveBeenCalledExactlyOnceWith("needle", null);
  await act(async () => {
    const task = useStore.getState().sessions.get("task");
    if (task) useStore.setState({ sessions: new Map([[task.id, { ...task, updatedAt: 2 }]]) });
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(searchTasks).toHaveBeenCalledTimes(1);
  await act(async () => {
    const task = useStore.getState().sessions.get("task");
    if (task) useStore.setState({ sessions: new Map([[task.id, { ...task, title: "Renamed" }]]) });
    await vi.advanceTimersByTimeAsync(200);
  });
  expect(searchTasks).toHaveBeenCalledTimes(2);
});

test.each(["提供商名称", "Base URL", "API key"])(
  "provider switching preserves unsaved %s until discard is confirmed",
  async (label) => {
    await act(async () => root.render(createElement(SettingsPage, { onClose: vi.fn() })));
    await click(query('button[aria-label="模型"]'));
    await fill(label, "unsaved edit");
    await click(query('[data-provider-id="second"]'));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain("放弃未保存");
    await click(button("继续编辑"));
    expect(query<HTMLInputElement>(`input[aria-label="${label}"]`).value).toBe("unsaved edit");
    await click(query('[data-provider-id="second"]'));
    await click(button("放弃更改并继续"));
    expect(query<HTMLInputElement>('input[aria-label="提供商名称"]').value).toBe("second");
    expect(query<HTMLInputElement>('input[aria-label="API key"]').value).toBe("second-key");
    expect(saveProvider).not.toHaveBeenCalled();
  },
);

test("credential hydration does not make an untouched provider appear dirty", async () => {
  await act(async () => root.render(createElement(SettingsPage, { onClose: vi.fn() })));
  await click(query('button[aria-label="模型"]'));
  await click(query('[data-provider-id="second"]'));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(query<HTMLInputElement>('input[aria-label="提供商名称"]').value).toBe("second");
});

test.each(["back", "Escape"])(
  "%s protects unsaved provider edits across settings categories",
  async (action) => {
    const onClose = vi.fn();
    await act(async () => root.render(createElement(SettingsPage, { onClose })));
    await click(query('button[aria-label="模型"]'));
    await fill("API key", "unsaved-secret");
    await click(query('button[aria-label="界面设置"]'));
    const close = () =>
      action === "back"
        ? click(query('button[aria-label="关闭设置"]'))
        : pressEscape(query(".settings-screen"));
    await close();
    expect(onClose).not.toHaveBeenCalled();
    expect(query('[role="dialog"]').textContent).toContain("放弃未保存的更改");
    await click(button("继续编辑"));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await click(query('button[aria-label="模型"]'));
    expect(query<HTMLInputElement>('input[aria-label="API key"]').value).toBe("unsaved-secret");
    await close();
    await pressEscape(button("继续编辑"));
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await close();
    await click(button("放弃更改并继续"));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(saveProvider).not.toHaveBeenCalled();
  },
);

test.each(["back", "Escape"])("%s closes untouched settings without a discard prompt", async (action) => {
  const onClose = vi.fn();
  await act(async () => root.render(createElement(SettingsPage, { onClose })));
  if (action === "back") await click(query('button[aria-label="关闭设置"]'));
  else await pressEscape(query(".settings-screen"));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("saving blocks closing, a failed save preserves edits, and a successful retry clears the guard", async () => {
  const onClose = vi.fn();
  let rejectSave!: (error: Error) => void;
  saveProvider.mockImplementationOnce(() => new Promise((_, reject) => (rejectSave = reject)));
  await act(async () => root.render(createElement(SettingsPage, { onClose })));
  await click(query('button[aria-label="模型"]'));
  await fill("Base URL", "https://edited.invalid/v1");
  await click(button("保存提供商"));
  expect(query<HTMLButtonElement>('button[aria-label="关闭设置"]').disabled).toBe(true);
  await click(query('button[aria-label="关闭设置"]'));
  await pressEscape(query(".settings-screen"));
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  await act(async () => rejectSave(new Error("保存失败")));
  expect(query('[role="alert"]').textContent).toContain("保存失败");
  expect(query<HTMLInputElement>('input[aria-label="Base URL"]').value).toBe("https://edited.invalid/v1");
  await click(query('button[aria-label="关闭设置"]'));
  await click(button("继续编辑"));
  const saved = structuredClone(useStore.getState().settings) as PublicSettings;
  saved.providers[0].baseUrl = "https://edited.invalid/v1";
  saveProvider.mockResolvedValueOnce({ ok: true, value: saved });
  await click(button("保存提供商"));
  await click(query('button[aria-label="关闭设置"]'));
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("Escape in a model dialog only dismisses that dialog and preserves the provider draft", async () => {
  const onClose = vi.fn();
  await act(async () => root.render(createElement(SettingsPage, { onClose })));
  await click(query('button[aria-label="模型"]'));
  await fill("Base URL", "https://edited.invalid/v1");
  await click(query('button[aria-label="编辑模型 fake"]'));
  await pressEscape(query('[aria-label="上下文容量"]'));
  expect(onClose).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(query<HTMLInputElement>('input[aria-label="Base URL"]').value).toBe("https://edited.invalid/v1");
});
