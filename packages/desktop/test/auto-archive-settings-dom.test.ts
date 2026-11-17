import { defaultPluginSettings } from "@zpi-dev/builtin-plugins";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ArchivedTasks } from "../src/renderer/ArchivedTasks.tsx";
import { useStore } from "../src/renderer/store.ts";
import type { DesktopBridge, PublicSettings } from "../src/shared/bridge.ts";
import { defaultPreferences } from "../src/shared/config.ts";
import { defaultShortcuts } from "../src/shared/shortcuts.ts";
import { emptyTaskGroups } from "../src/shared/task-groups.ts";

let root: Root;
let container: HTMLDivElement;
let settings: PublicSettings;
const updateAutoArchive = vi.fn<DesktopBridge["updateAutoArchive"]>();
const runAutoArchive = vi.fn<DesktopBridge["runAutoArchive"]>();
const listArchivedSessions = vi.fn<DesktopBridge["listArchivedSessions"]>();
const listRecentSessions = vi.fn<DesktopBridge["listRecentSessions"]>();
const getSettings = vi.fn<DesktopBridge["getSettings"]>();
const unsubscribe = vi.fn();
let tasksChanged: (() => void) | undefined;
const click = async (element: HTMLElement) => {
  await act(async () => element.click());
};
const button = (text: string) => {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (entry) => entry.textContent === text,
  );
  expect(found, text).toBeDefined();
  return found as HTMLButtonElement;
};
const toggle = () => {
  const found = container.querySelector<HTMLInputElement>('[role="switch"]');
  expect(found).not.toBeNull();
  return found as HTMLInputElement;
};

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  settings = {
    autoArchive: { enabled: false, olderThanDays: 30 },
    providers: [],
    lastSelection: null,
    interface: defaultPreferences,
    shortcuts: defaultShortcuts("darwin"),
    plugins: structuredClone(defaultPluginSettings),
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
  updateAutoArchive.mockReset().mockImplementation(async (autoArchive) => {
    settings = { ...settings, autoArchive };
    return { ok: true, value: settings };
  });
  runAutoArchive.mockReset().mockResolvedValue({
    ok: true,
    value: {
      archived: 2,
      skipped: 1,
      details: [{ sessionId: "sess_dirty", title: "未完成的修改", reason: "worktree 有未提交文件" }],
    },
  });
  listArchivedSessions.mockReset().mockResolvedValue({ ok: true, value: [] });
  listRecentSessions.mockReset().mockResolvedValue({ ok: true, value: [] });
  getSettings.mockReset().mockImplementation(async () => ({ ok: true, value: settings }));
  unsubscribe.mockReset();
  tasksChanged = undefined;
  useStore.setState({ settings, sessions: new Map(), selected: undefined });
  Object.defineProperty(window, "zpi", {
    configurable: true,
    value: {
      updateAutoArchive,
      runAutoArchive,
      listArchivedSessions,
      listRecentSessions,
      getSettings,
      onTasksChanged: (listener: () => void) => {
        tasksChanged = listener;
        return unsubscribe;
      },
      listProjects: async () => ({ ok: true, value: [] }),
      getTaskGroups: async () => ({ ok: true, value: emptyTaskGroups() }),
    },
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(ArchivedTasks)));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

test("manual archiving works with automatic archiving off and reports skipped worktrees", async () => {
  expect(toggle().checked).toBe(false);
  expect(button("立即归档").disabled).toBe(false);
  const retention = container.querySelector<HTMLButtonElement>('[aria-label="归档保留时长"]');
  expect(retention?.disabled).toBe(false);
  expect(retention?.textContent).toContain("30 天后归档");
  await click(button("立即归档"));
  expect(runAutoArchive).toHaveBeenCalledOnce();
  expect(updateAutoArchive).not.toHaveBeenCalled();
  expect(toggle().checked).toBe(false);
  expect(container.textContent).toContain("已归档 2 个任务，跳过 1 个任务。");
  expect(container.textContent).toContain("未完成的修改：worktree 有未提交文件");
  expect(listArchivedSessions).toHaveBeenCalledTimes(2);
  expect(listRecentSessions).toHaveBeenCalledOnce();
});

test("saving automatic archiving uses the persisted settings and leaves failures retryable", async () => {
  updateAutoArchive.mockRejectedValueOnce(new Error("设置保存失败"));
  await click(toggle());
  expect(toggle().checked).toBe(false);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("设置保存失败");
  await click(toggle());
  expect(updateAutoArchive).toHaveBeenLastCalledWith({ enabled: true, olderThanDays: 30 });
  expect(toggle().checked).toBe(true);
  expect(useStore.getState().settings?.autoArchive.enabled).toBe(true);
  expect(runAutoArchive).not.toHaveBeenCalled();
});

test("manual scan shows progress, prevents overlapping actions, and reports failure without success", async () => {
  let rejectScan: (error: Error) => void = () => {};
  runAutoArchive.mockImplementationOnce(
    () =>
      new Promise((_, reject) => {
        rejectScan = reject;
      }),
  );
  await click(button("立即归档"));
  expect(button("正在归档…").disabled).toBe(true);
  expect(toggle().disabled).toBe(true);
  expect(container.textContent).toContain("正在检查历史任务并清理 worktree…");
  expect(listRecentSessions).not.toHaveBeenCalled();
  await act(async () => rejectScan(new Error("历史任务检查失败")));
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("历史任务检查失败");
  expect(container.textContent).not.toContain("已归档 2 个任务");
  expect(button("立即归档").disabled).toBe(false);
});

test("background archive changes refresh the list and unsubscribe when leaving settings", async () => {
  expect(listArchivedSessions).toHaveBeenCalledOnce();
  await act(async () => tasksChanged?.());
  expect(listArchivedSessions).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  expect(unsubscribe).toHaveBeenCalledOnce();
});
