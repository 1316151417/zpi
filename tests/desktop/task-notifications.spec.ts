import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import type { Notification } from "electron";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

// Exercise real Electron -> preload -> renderer delivery, intercepting only OS display.
declare global {
  var notificationTest: { focused: boolean; shown: Notification[]; presentation: string[] };
}

test("auxiliary replies mark the parent task and tab unread, and system notifications reopen the right tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-chat-notifications-"));
  const firstReply = deferred();
  const secondReply = deferred();
  const server = await fakeServer(async (_, response, index) => {
    send(response, chunk({ content: `回复 ${index}` }));
    if (index === 1) await firstReply.promise;
    if (index === 2) await secondReply.promise;
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow, Notification }) => {
      globalThis.notificationTest = { focused: true, shown: [], presentation: [] };
      Notification.isSupported = () => true;
      Notification.prototype.show = function () {
        globalThis.notificationTest.shown.push(this);
      };
      for (const window of BrowserWindow.getAllWindows())
        window.isFocused = () => globalThis.notificationTest.focused;
    });
    await page.evaluate(() => {
      // The test runner deliberately keeps the native window hidden and non-focusable.
      Object.defineProperty(document, "visibilityState", { value: "visible" });
      document.hasFocus = () => true;
    });
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("父任务");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".topbar-title")).toHaveText("父任务");
    const parentId = await page.evaluate(() => localStorage.getItem("zpi.selectedSession"));
    const parent = page.locator(`[data-session-id="${parentId}"]`);
    const dot = '[data-unread-indicator="true"]';
    const addSideChat = () =>
      page
        .locator(".pane-empty-launcher:visible")
        .getByRole("button", { name: "辅助对话", exact: true })
        .click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    const sendSide = async (text: string) => {
      const editor = side.getByLabel("消息", { exact: true });
      await editor.fill(text);
      await editor.press("Enter");
    };
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await addSideChat();
    await sendSide("第一条辅助问题");
    await expect(side.locator(".answer")).toHaveText("回复 1");
    const first = page.getByRole("tab", { name: "辅助对话 1", exact: true });
    const second = page.getByRole("tab", { name: "辅助对话 2", exact: true });
    await page.getByLabel("新增侧栏标签", { exact: true }).click();
    await addSideChat();
    await expect(second).toHaveAttribute("aria-selected", "true");
    firstReply.resolve();
    await expect(first.locator(dot)).toBeVisible();
    await expect(parent.locator(dot)).toBeVisible();
    expect(await app.evaluate(() => globalThis.notificationTest.shown.length)).toBe(0);

    await page.getByRole("button", { name: "筛选视图", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "按分组", exact: true }).click();
    await expect(parent.locator(dot)).toBeVisible();
    await sendSide("第二条辅助问题");
    await expect(side.locator(".answer")).toHaveText("回复 2");
    await page.getByLabel("进入完整视图", { exact: true }).click();
    await page.locator(".pane-conversation-tab").click();
    await expect(first.locator(dot)).toBeVisible();
    await second.click();
    await expect(second).toHaveAttribute("aria-selected", "true");
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event("blur"));
    });
    await app.evaluate(() => {
      globalThis.notificationTest.focused = false;
    });
    secondReply.resolve();
    await expect(second.locator(dot)).toBeVisible();
    await expect.poll(() => app?.evaluate(() => globalThis.notificationTest.shown.length)).toBe(1);
    expect(await app.evaluate(() => globalThis.notificationTest.shown[0].title)).toBe("辅助对话已完成");

    await first.click();
    await expect(first).toHaveAttribute("aria-selected", "true");
    await page.locator(".sidebar-global").getByRole("button", { name: "新建任务", exact: true }).click();
    await expect(page.locator(".topbar-title")).toHaveText("新任务");
    await page.evaluate(() => {
      document.hasFocus = () => true;
    });
    await app.evaluate(({ app, BrowserWindow }) => {
      globalThis.notificationTest.focused = true;
      const window = BrowserWindow.getAllWindows()[0];
      window.isVisible = () => true;
      window.focus = () => {};
      if (process.platform === "darwin") {
        if (app.dock) app.dock.show = async () => {};
        app.show = () => {};
        app.focus = () => {};
      }
      globalThis.notificationTest.shown[0].emit("click");
    });
    await expect(second).toHaveAttribute("aria-selected", "true");
    await expect(side.locator(".answer")).toHaveText("回复 2");
    await expect(second.locator(dot)).toHaveCount(0);
    await expect(first.locator(dot)).toBeVisible();
    await expect(parent.locator(dot)).toBeVisible();
    await first.click();
    await expect(first.locator(dot)).toHaveCount(0);
    await expect(parent.locator(dot)).toHaveCount(0);
    await sendSide("在当前标签继续提问");
    await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(first.locator(dot)).toHaveCount(0);
    const childId = await side.getAttribute("data-side-chat-session");
    expect(
      await page.evaluate(async (id) => {
        if (!id) throw new Error("Missing side chat ID");
        const snapshot = await window.zpi.getSessionSnapshot(id);
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        return snapshot.value.session.unreadAt;
      }, childId),
    ).toBeUndefined();
  } finally {
    firstReply.resolve();
    secondReply.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("ZCode notification settings, disabled sound state and independent preferences survive restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-notification-preferences-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    const master = page.getByRole("switch", { name: "任务通知", exact: true });
    const sound = page.getByRole("switch", { name: "通知声音", exact: true });
    await expect(master).toBeChecked();
    await expect(sound).toBeChecked();
    await expect(sound).toBeEnabled();
    const track = page.locator(".task-notification-switch > span").first();
    await expect(track).toHaveCSS("width", "32px");
    await expect(track).toHaveCSS("height", "18px");
    await page.screenshot({ path: "test-results/task-notifications-settings-light.png" });
    await master.uncheck();
    await expect(sound).toBeDisabled();
    await expect(sound).toBeChecked();
    await master.check();
    await sound.uncheck();
    await master.uncheck();
    await expect(sound).not.toBeChecked();
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await expect(page.getByRole("switch", { name: "任务通知" })).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "通知声音" })).toBeDisabled();
    await expect(page.getByRole("switch", { name: "通知声音" })).not.toBeChecked();
    await page.getByRole("switch", { name: "任务通知" }).check();
    await expect(page.getByRole("switch", { name: "通知声音" })).toBeEnabled();
    await expect(page.getByRole("switch", { name: "通知声音" })).not.toBeChecked();
    await page.getByRole("button", { name: "界面设置", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.screenshot({ path: "test-results/task-notifications-settings-dark.png" });
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("live task completion, failure and interruption notify once, and clicking restores the matching task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-notifications-"));
  const responses = new Map<number, import("node:http").ServerResponse>();
  const server = await fakeServer((_, response, index) => {
    responses.set(index, response);
    send(response, chunk({ content: `reply ${index}` }));
  });
  const responseAt = (index: number) => {
    const response = responses.get(index);
    if (!response) throw new Error(`Missing response ${index}`);
    return response;
  };
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await app.evaluate(({ BrowserWindow, Notification }) => {
      globalThis.notificationTest = { focused: true, shown: [], presentation: [] };
      Notification.isSupported = () => true;
      Notification.prototype.show = function () {
        globalThis.notificationTest.shown.push(this);
      };
      for (const window of BrowserWindow.getAllWindows())
        window.isFocused = () => globalThis.notificationTest.focused;
    });
    // Observe the bridge sound signal independently of whether OS autoplay is permitted.
    await page.evaluate(() => {
      (window as unknown as { notificationSounds: number }).notificationSounds = 0;
      window.zpi.onTaskNotificationSound(() => {
        (window as unknown as { notificationSounds: number }).notificationSounds++;
      });
    });
    const start = async (text: string) =>
      page.evaluate(async (text) => {
        const session = await window.zpi.createSession(null);
        if (!session.ok) throw new Error(session.error.message);
        const run = await window.zpi.startRun({ sessionId: session.value.id, text });
        if (!run.ok) throw new Error(run.error.message);
        return { id: session.value.id, runId: run.value.runId };
      }, text);
    const count = () => app?.evaluate(() => globalThis.notificationTest.shown.length);

    const foreground = await start("前台完成");
    await expect.poll(() => responses.has(0)).toBe(true);
    done(responseAt(0));
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const snapshot = await window.zpi.getSessionSnapshot(id);
          return snapshot.ok ? snapshot.value.session.status : "error";
        }, foreground.id),
      )
      .toBe("completed");
    expect(await count()).toBe(0);

    await app.evaluate(() => {
      globalThis.notificationTest.focused = false;
    });
    const completed = await start("后台完成");
    await expect.poll(() => responses.has(1)).toBe(true);
    done(responseAt(1));
    await expect.poll(count).toBe(1);
    expect(
      await app.evaluate(() => {
        const notification = globalThis.notificationTest.shown[0];
        return { title: notification.title, body: notification.body, silent: notification.silent };
      }),
    ).toEqual({ title: "任务已完成", body: "任务：后台完成", silent: true });
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { notificationSounds: number }).notificationSounds),
      )
      .toBe(1);

    // Keep native presentation intercepted; unit tests cover the actual restoration calls.
    // The click still goes through main and preload while the settings page is open.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await app.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      let minimized = true;
      let visible = false;
      window.isMinimized = () => minimized;
      window.isVisible = () => visible;
      window.restore = () => {
        globalThis.notificationTest.presentation.push("restore");
        minimized = false;
      };
      window.show = () => {
        globalThis.notificationTest.presentation.push("window.show");
        visible = true;
      };
      window.focus = () => {
        globalThis.notificationTest.presentation.push("window.focus");
      };
      if (process.platform === "darwin") {
        if (app.dock)
          app.dock.show = async () => {
            globalThis.notificationTest.presentation.push("dock.show");
          };
        app.show = () => {
          globalThis.notificationTest.presentation.push("app.show");
        };
        app.focus = () => {
          globalThis.notificationTest.presentation.push("app.focus");
        };
      }
      globalThis.notificationTest.shown[0].emit("click");
    });
    await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0);
    await expect(page.locator(".topbar-title")).toHaveText("后台完成");
    await expect(page.locator(".answer")).toHaveText("reply 1");
    expect(await page.evaluate(() => localStorage.getItem("zpi.selectedSession"))).toBe(completed.id);
    expect(
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { minimized: window.isMinimized(), visible: window.isVisible() };
      }),
    ).toEqual({ minimized: false, visible: true });
    expect(await app.evaluate(() => globalThis.notificationTest.presentation)).toEqual([
      "restore",
      "window.show",
      ...(process.platform === "darwin" ? ["dock.show", "app.show", "app.focus"] : []),
      "window.focus",
    ]);

    const interrupted = await start("手动停止");
    await expect.poll(() => responses.has(2)).toBe(true);
    await page.evaluate(async ({ id, runId }) => {
      const result = await window.zpi.abortRun({ sessionId: id, runId });
      if (!result.ok) throw new Error(result.error.message);
    }, interrupted);
    await expect.poll(count).toBe(2);
    expect(await app.evaluate(() => globalThis.notificationTest.shown[1].title)).toBe("任务已完成");

    await start("任务失败");
    await expect.poll(() => responses.has(3)).toBe(true);
    send(responseAt(3), { error: { message: "provider rejected", type: "invalid_request_error" } });
    responseAt(3).end("data: [DONE]\n\n");
    await expect.poll(count).toBe(3);
    expect(await app.evaluate(() => globalThis.notificationTest.shown[2].title)).toBe("任务出错");

    await page.evaluate(async () => {
      const result = await window.zpi.updatePreferences({ notificationEnabled: false });
      if (!result.ok) throw new Error(result.error.message);
    });
    const disabled = await start("已关闭通知");
    await expect.poll(() => responses.has(4)).toBe(true);
    done(responseAt(4));
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const snapshot = await window.zpi.getSessionSnapshot(id);
          return snapshot.ok ? snapshot.value.session.status : "error";
        }, disabled.id),
      )
      .toBe("completed");
    expect(await count()).toBe(3);
    await page.reload();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    expect(await count()).toBe(3);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
