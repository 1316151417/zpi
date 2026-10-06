import type { DesktopEventEnvelope } from "ZPI-ui";
import { EventEmitter } from "node:events";
import type { BrowserWindow } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { TaskNotifications } from "../src/main/task-notifications.ts";
import { defaultPreferences } from "../src/shared/config.ts";

const electron = vi.hoisted(() => ({
  supported: true,
  windows: [] as { isDestroyed: () => boolean; isFocused: () => boolean }[],
  notifications: [] as (EventEmitter & {
    options: { title: string; body: string; silent: boolean };
    show: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  })[],
  calls: [] as string[],
  showError: false,
}));
vi.mock("electron", () => ({
  app: {
    dock: { show: () => electron.calls.push("dock.show") },
    show: () => electron.calls.push("app.show"),
    focus: () => electron.calls.push("app.focus"),
  },
  BrowserWindow: { getAllWindows: () => electron.windows },
  Notification: class extends EventEmitter {
    static isSupported() {
      return electron.supported;
    }
    options;
    show = vi.fn(() => {
      if (electron.showError) throw new Error("notification unavailable");
    });
    close = vi.fn();
    constructor(options: { title: string; body: string; silent: boolean }) {
      super();
      this.options = options;
      electron.notifications.push(this);
    }
  },
}));

const settled = (status: "completed" | "error" | "aborted", sessionId = "task"): DesktopEventEnvelope => ({
  sessionId,
  runId: "run",
  seq: 3,
  event: { type: "settled", status, endedAt: Date.now() },
});
function setup() {
  const state = { focused: false, destroyed: false, minimized: false, visible: true };
  const window = {
    isFocused: () => state.focused,
    isDestroyed: () => state.destroyed,
    isMinimized: () => state.minimized,
    isVisible: () => state.visible,
    restore: () => electron.calls.push("restore"),
    show: () => electron.calls.push("window.show"),
    focus: () => electron.calls.push("window.focus"),
    webContents: { send: vi.fn() },
  };
  electron.windows = [window];
  const preferences = { ...defaultPreferences };
  const notifications = new TaskNotifications(window as unknown as BrowserWindow, () => preferences);
  return { notifications, window, state, preferences };
}
beforeEach(() => {
  electron.supported = true;
  electron.showError = false;
  electron.notifications = [];
  electron.calls = [];
  vi.useFakeTimers();
  vi.setSystemTime(10000);
});
afterEach(() => vi.useRealTimers());

it("matches ZCode copy, silent system delivery, custom sound and interrupted completion", () => {
  const { notifications, window } = setup();
  for (const [status, title] of [
    ["completed", "任务已完成"],
    ["error", "任务出错"],
    ["aborted", "任务已完成"],
  ] as const) {
    expect(notifications.handle(settled(status, status), "  修复登录  ")).toBe(true);
    expect(electron.notifications.at(-1)?.options).toEqual({ title, body: "任务：修复登录", silent: true });
  }
  expect(window.webContents.send).toHaveBeenCalledTimes(3);
  expect(window.webContents.send).toHaveBeenCalledWith("ZPI:task-notification-sound");
  expect(notifications.handle(settled("error", "blank"), " ")).toBe(true);
  expect(electron.notifications.at(-1)?.options.body).toBe("任务出错");
});

it("suppresses every task while any live app window is focused, and respects the master switch", () => {
  const { notifications, state, preferences } = setup();
  state.focused = true;
  expect(notifications.handle(settled("completed"), "任务")).toBe(false);
  state.focused = false;
  electron.windows.push({ isDestroyed: () => false, isFocused: () => true });
  expect(notifications.handle(settled("completed"), "任务")).toBe(false);
  electron.windows.pop();
  preferences.notificationEnabled = false;
  expect(notifications.handle(settled("completed"), "任务")).toBe(false);
  preferences.notificationEnabled = true;
  electron.supported = false;
  expect(notifications.handle(settled("completed"), "任务")).toBe(false);
  electron.supported = true;
  state.destroyed = true;
  expect(notifications.handle(settled("completed"), "任务")).toBe(false);
  state.destroyed = false;
  expect(electron.notifications).toHaveLength(0);
  // Suppressed attempts do not consume the three-second deduplication window.
  expect(notifications.handle(settled("completed"), "任务")).toBe(true);
});

it("deduplicates by task and terminal category for three seconds without replaying nonterminal events", () => {
  const { notifications } = setup();
  expect(notifications.handle(settled("completed"), "任务")).toBe(true);
  expect(notifications.handle(settled("aborted"), "任务")).toBe(false);
  expect(notifications.handle(settled("error"), "任务")).toBe(true);
  expect(notifications.handle(settled("completed", "other"), "任务")).toBe(true);
  vi.advanceTimersByTime(2999);
  expect(notifications.handle(settled("completed"), "任务")).toBe(false);
  vi.advanceTimersByTime(1);
  expect(notifications.handle(settled("completed"), "任务")).toBe(true);
  expect(
    notifications.handle(
      { sessionId: "old", runId: "title", seq: 1, event: { type: "session_changed", title: "旧任务" } },
      "旧任务",
    ),
  ).toBe(false);
});

it("restores and shows the sender window before activating the app, focusing and navigating", () => {
  const { notifications, window, state } = setup();
  state.minimized = true;
  state.visible = false;
  notifications.handle(settled("completed"), "任务");
  electron.notifications[0].emit("click");
  expect(electron.calls).toEqual([
    "restore",
    "window.show",
    ...(process.platform === "darwin" ? ["dock.show", "app.show", "app.focus"] : []),
    "window.focus",
  ]);
  expect(window.webContents.send).toHaveBeenLastCalledWith("ZPI:task-notification-click", "task");
  notifications.dispose();
  expect(electron.notifications[0].close).not.toHaveBeenCalled();
});

it("releases closed or failed notifications and closes retained notifications on shutdown", () => {
  const { notifications } = setup();
  for (const id of ["closed", "failed", "pending"]) notifications.handle(settled("completed", id), "任务");
  electron.notifications[0].emit("close");
  electron.notifications[1].emit("failed", new Error("denied"));
  notifications.dispose();
  expect(electron.notifications.map((notification) => notification.close.mock.calls.length)).toEqual([
    0, 0, 1,
  ]);
  electron.notifications[2].emit("click");
  expect(electron.calls).toEqual([]);
  expect(notifications.handle(settled("completed", "new"), "任务")).toBe(false);
});

it("does not navigate a destroyed window or propagate native notification errors", () => {
  const { notifications, state } = setup();
  notifications.handle(settled("completed"), "任务");
  state.destroyed = true;
  electron.notifications[0].emit("click");
  expect(electron.calls).toEqual([]);
  state.destroyed = false;
  electron.showError = true;
  expect(notifications.handle(settled("completed", "failure"), "任务")).toBe(false);
});

it("bounds retained native notification objects to ZCode's latest 100", () => {
  const { notifications } = setup();
  for (let i = 0; i < 101; i++) notifications.handle(settled("completed", `task-${i}`), "任务");
  notifications.dispose();
  expect(electron.notifications[0].close).not.toHaveBeenCalled();
  expect(
    electron.notifications.slice(1).every((notification) => notification.close.mock.calls.length === 1),
  ).toBe(true);
});
