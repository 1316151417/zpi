import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { Notification } from "electron";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

// Exercise real Electron -> preload -> renderer delivery, intercepting only OS display.
declare global {
  var notificationTest: { focused: boolean; shown: Notification[]; presentation: string[] };
}

test("ZCode notification settings, disabled sound state and independent preferences survive restarts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-notification-preferences-"));
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
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("live task completion, failure and interruption notify once, and clicking restores the matching task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-task-notifications-"));
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
      window.ZPI.onTaskNotificationSound(() => {
        (window as unknown as { notificationSounds: number }).notificationSounds++;
      });
    });
    const start = async (text: string) =>
      page.evaluate(async (text) => {
        const session = await window.ZPI.createSession(null);
        if (!session.ok) throw new Error(session.error.message);
        const run = await window.ZPI.startRun({ sessionId: session.value.id, text });
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
          const snapshot = await window.ZPI.getSessionSnapshot(id);
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
    expect(await page.evaluate(() => localStorage.getItem("ZPI.selectedSession"))).toBe(completed.id);
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
      const result = await window.ZPI.abortRun({ sessionId: id, runId });
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
      const result = await window.ZPI.updatePreferences({ notificationEnabled: false });
      if (!result.ok) throw new Error(result.error.message);
    });
    const disabled = await start("已关闭通知");
    await expect.poll(() => responses.has(4)).toBe(true);
    done(responseAt(4));
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const snapshot = await window.ZPI.getSessionSnapshot(id);
          return snapshot.ok ? snapshot.value.session.status : "error";
        }, disabled.id),
      )
      .toBe("completed");
    expect(await count()).toBe(3);
    await page.reload();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    expect(await count()).toBe(3);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
