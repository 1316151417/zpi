import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("quick chat streams in its own isolated window, survives hide/reload, and leaves main tasks alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-desktop-"));
  const finish = deferred();
  const server = await fakeServer(async (_request, response) => {
    send(response, chunk({ content: "浮窗中的回复" }));
    await finish.promise;
    send(response, chunk({ content: "，已经完成。" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await main.getByLabel("消息", { exact: true }).fill("保留主窗口草稿");
    const before = await main.evaluate(() => window.zpi.listRecentSessions());
    const [quick] = await Promise.all([
      app.waitForEvent("window"),
      main.evaluate(() => window.zpi.openQuickChat()),
    ]);
    await expect(quick.getByTestId("quick-chat")).toBeVisible();
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toHaveCount(0);
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
    const quickHeight = () =>
      app?.evaluate(
        ({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()
            .find((window) => window.webContents.getURL().includes("view=quick-chat"))
            ?.getBounds().height,
      );
    expect(await quickHeight()).toBe(112);
    expect(await quick.evaluate(() => typeof window.zpi)).toBe("undefined");
    expect(await quick.evaluate(() => typeof window.zpiQuickChat.send)).toBe("function");
    await quick.getByRole("textbox", { name: "输入消息", exact: true }).fill("只在浮窗回答");
    expect(await quick.evaluate(() => "setSelection" in window.zpiQuickChat)).toBe(false);
    await quick.getByRole("textbox", { name: "输入消息", exact: true }).press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect.poll(quickHeight).toBe(560);
    await expect(quick.getByTestId("run")).toContainText("浮窗中的回复");
    await quick.getByRole("button", { name: "隐藏", exact: true }).click();
    await quick.reload();
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect.poll(quickHeight).toBe(560);
    finish.resolve();
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(quick.getByTestId("run")).toContainText("已经完成");
    await expect(main.getByLabel("消息", { exact: true })).toHaveValue("保留主窗口草稿");
    expect(await main.evaluate(() => window.zpi.listRecentSessions())).toEqual(before);
    expect(await quick.evaluate(() => Object.keys(localStorage))).toEqual([]);
    const rejected = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const quickWindow = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("view=quick-chat"),
      );
      const handler = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers.get("zpi:call");
      if (!quickWindow || !handler) throw new Error("Missing quick-chat integration");
      return handler(
        { sender: quickWindow.webContents, senderFrame: quickWindow.webContents.mainFrame },
        "createSession",
        [null],
      );
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    await quick.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await expect.poll(quickHeight).toBe(112);
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
    expect(await main.evaluate(() => window.zpi.listRecentSessions())).toEqual(before);
    expect(app.windows()).toHaveLength(2);
  } finally {
    finish.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
