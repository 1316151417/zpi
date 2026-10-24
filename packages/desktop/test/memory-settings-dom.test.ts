import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type { ProviderRecord } from "../src/shared/bridge.ts";
import { defaultMemorySettings, type MemorySettings, type MemoryStatus } from "../src/shared/memory.ts";

const fixture = vi.hoisted(() => ({
  selected: "sess_example",
  settings: { providers: [] as ProviderRecord[] },
  selectSession: vi.fn(async () => {}),
}));
vi.mock("../src/renderer/store.ts", () => ({
  useStore: (selector: (state: typeof fixture) => unknown) => selector(fixture),
  selectSession: fixture.selectSession,
}));

import { MemorySettings as MemorySettingsPage } from "../src/renderer/MemorySettings.tsx";

let root: Root;
let container: HTMLDivElement;
let settings: MemorySettings;
let status: MemoryStatus;
const getMemorySettings = vi.fn(async () => ({ ok: true as const, value: settings }));
const getMemoryStatus = vi.fn(async () => ({ ok: true as const, value: status }));
const saveMemorySettings = vi.fn(async (input: MemorySettings) => {
  settings = structuredClone(input);
  return { ok: true as const, value: settings };
});
const openMemoryFile = vi.fn(async () => ({
  ok: true as const,
  value: { path: "/home/test/.zpi/MEMORY.md", content: "# Memory\n- [language] 中文", exists: true },
}));
const clearLongMemory = vi.fn(async () => ({ ok: true as const, value: status }));
const checkMemoryNow = vi.fn(async () => ({ ok: true as const, value: status }));
const onNavigate = vi.fn();

const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const button = (label: string) => {
  const found = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === label,
  );
  expect(found, label).toBeDefined();
  return found as HTMLButtonElement;
};
const toggle = (label: string) => {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  expect(found).not.toBeNull();
  return found as HTMLInputElement;
};
beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.clearAllMocks();
  settings = { ...defaultMemorySettings };
  status = {
    shortFiles: [
      {
        scope: "user",
        path: "/home/test/.zpi/MEMORY.md",
        exists: false,
        count: 0,
        characters: 0,
        diagnostics: [],
      },
    ],
    long: {
      path: "/storage/active/memory",
      running: false,
      status: "disabled",
      message: "长期记忆未启用",
      tokens: 0,
      cost: null,
      sources: [],
    },
  };
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      getMemorySettings,
      getMemoryStatus,
      saveMemorySettings,
      openMemoryFile,
      clearLongMemory,
      checkMemoryNow,
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
const render = async () => {
  await act(async () => root.render(createElement(MemorySettingsPage, { onNavigate })));
};
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

test("independent default-off switches keep the page compact", async () => {
  await render();
  expect(toggle("短记忆").checked).toBe(false);
  expect(toggle("长期记忆").checked).toBe(false);
  expect(container.textContent).not.toContain("0 / 20 条");
  expect(container.textContent).not.toContain("/home/test/.zpi/MEMORY.md");
  expect(container.querySelector('[aria-label="短记忆说明"]')).not.toBeNull();
  await click(toggle("短记忆"));
  expect(saveMemorySettings).toHaveBeenLastCalledWith({ ...defaultMemorySettings, short: true });
  await click(toggle("长期记忆"));
  expect(settings).toMatchObject({ short: true, long: true });
  await click(toggle("短记忆"));
  expect(settings).toMatchObject({ short: false, long: true });
  expect(clearLongMemory).not.toHaveBeenCalled();
});

test("pausing generation keeps long memory enabled and blocks immediate updates", async () => {
  settings.long = true;
  await render();
  expect(button("立即检查更新").disabled).toBe(false);
  await click(toggle("自动生成长期记忆"));
  expect(settings).toMatchObject({ long: true, generate: false });
  expect(button("立即检查更新").disabled).toBe(true);
  expect(clearLongMemory).not.toHaveBeenCalled();
});

test("file viewing uses the existing read bridge and editing only follows an explicit click", async () => {
  status.shortFiles[0].diagnostics = ["超过 2,000 字符，无法完整注入"];
  await render();
  expect(container.textContent).toContain("文件异常，未自动加载");
  expect(container.textContent).not.toContain("超过 2,000 字符");
  expect(openMemoryFile).not.toHaveBeenCalled();
  await click(button("查看"));
  expect(openMemoryFile).toHaveBeenCalledWith("sess_example", "user", "view");
  expect(document.querySelector(".memory-preview pre")?.textContent).toContain("[language] 中文");
  expect(document.querySelector(".memory-preview")?.textContent).toContain("0 / 20 条");
  expect(document.querySelector(".memory-preview")?.textContent).toContain("超过 2,000 字符");
  await click(document.querySelector('[aria-label="关闭记忆文件"]') as HTMLElement);
  await click(button("编辑"));
  expect(openMemoryFile).toHaveBeenLastCalledWith("sess_example", "user", "edit");
});

test("clear is explicit and remains available during an active background run", async () => {
  status.long.running = true;
  await render();
  await click(button("清空长期记忆…"));
  expect(clearLongMemory).not.toHaveBeenCalled();
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("无法撤销");
  expect(document.activeElement).toBe(button("取消"));
  await click(button("取消"));
  expect(clearLongMemory).not.toHaveBeenCalled();
  await click(button("清空长期记忆…"));
  await click(button("清空"));
  expect(clearLongMemory).toHaveBeenCalledOnce();
  expect(container.textContent).toContain("长期记忆已清空");
});

test("unavailable manual models remain visible and never switch providers", async () => {
  settings.modelMode = "manual";
  settings.selection = { provider: "missing", modelId: "removed", reasoning: "high" };
  await render();
  expect(container.textContent).toContain("missing / removed（不可用）");
  expect(container.textContent).toContain("不会自动切换");
  expect(saveMemorySettings).not.toHaveBeenCalled();
  expect(checkMemoryNow).not.toHaveBeenCalled();
});

test("source links navigate through the existing session owner", async () => {
  status.long.sources = [{ sessionId: "sess_source", title: "来源会话", workspace: "/project" }];
  await render();
  const link = container.querySelector<HTMLAnchorElement>('a[href="#sess_source"]');
  expect(link).not.toBeNull();
  await click(link as HTMLAnchorElement);
  expect(fixture.selectSession).toHaveBeenCalledWith("sess_source");
  expect(onNavigate).toHaveBeenCalledOnce();
});

test("status polling stops when the settings page unmounts", async () => {
  vi.useFakeTimers();
  await render();
  expect(getMemoryStatus).toHaveBeenCalledOnce();
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(getMemoryStatus).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  await act(async () => vi.advanceTimersByTimeAsync(6000));
  expect(getMemoryStatus).toHaveBeenCalledTimes(2);
});

test("shows sources actually read this turn separately from the long-term library", async () => {
  status.usedSources = [
    {
      sessionId: "sess_used",
      title: "本轮来源",
      workspace: "/project",
      summaryPath: "/memory/rollout_summaries/used.md",
    },
  ];
  status.long.sources = [{ sessionId: "sess_other", title: "库中来源", workspace: "/other" }];
  await render();
  expect(container.textContent).toContain("本轮读取的记忆（1）");
  expect(container.textContent).toContain("长期库来源（1）");
  expect(container.textContent).not.toContain("/memory/rollout_summaries/used.md");
  expect(container.querySelector('a[href="#sess_used"]')?.textContent).toBe("本轮来源");
  expect(container.querySelector('[aria-label="短记忆说明"]')).not.toBeNull();
});

test("long memory opens externally and missing files show inline notices without a dialog", async () => {
  await render();
  await click(button("查看长期记忆"));
  expect(openMemoryFile).toHaveBeenLastCalledWith("sess_example", "long", "view");
  expect(container.textContent).toContain("已用默认程序打开长期记忆");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  openMemoryFile.mockResolvedValueOnce({
    ok: true,
    value: { path: "/memory/MEMORY.md", content: "", exists: false },
  });
  await click(button("查看长期记忆"));
  expect(container.textContent).toContain("长期记忆尚未生成");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  openMemoryFile.mockResolvedValueOnce({
    ok: true,
    value: { path: "/user/MEMORY.md", content: "", exists: false },
  });
  await click(button("查看"));
  expect(container.textContent).toContain("记忆文件尚未创建");
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

test("failed clearing keeps the confirmation open for retry", async () => {
  clearLongMemory.mockRejectedValueOnce(new Error("清空失败"));
  await render();
  await click(button("清空长期记忆…"));
  await click(button("清空"));
  expect(document.querySelector('[role="dialog"]')?.textContent).toContain("清空失败");
  await click(button("清空"));
  expect(clearLongMemory).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});
