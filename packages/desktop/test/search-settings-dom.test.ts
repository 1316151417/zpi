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
      listTaskFiles: async () => ({ ok: true, value: [] }),
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
    const button = (text: string) =>
      [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (entry) => entry.textContent === text,
      ) as HTMLButtonElement;
    await click(button("继续编辑"));
    expect(query<HTMLInputElement>(`input[aria-label="${label}"]`).value).toBe("unsaved edit");
    await click(query('[data-provider-id="second"]'));
    await click(button("放弃更改并切换"));
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
