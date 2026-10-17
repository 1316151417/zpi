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
    await main.evaluate(() => window.zpi.openQuickChat());
    // Reuse the prewarmed page when present instead of relying on a new-window event.
    const quickPage = () => app?.windows().find((page) => page.url().includes("view=quick-chat"));
    await expect.poll(() => Boolean(quickPage())).toBe(true);
    const quick = quickPage();
    if (!quick) throw new Error("Missing quick-chat page");
    await expect(quick.getByTestId("quick-chat")).toBeVisible();
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(quick.getByRole("button", { name: /^(隐藏|关闭)$/ })).toHaveCount(0);
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
    const quickBounds = () =>
      app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("view=quick-chat"))
          ?.getBounds(),
      );
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    const compactBounds = await quickBounds();
    if (!compactBounds) throw new Error("Missing compact bounds");
    const compactBottom = compactBounds.y + compactBounds.height;
    const sendButton = quick.getByRole("button", { name: "发送", exact: true });
    await expect(sendButton).toHaveCSS("width", "28px");
    await expect(sendButton).toHaveCSS("height", "28px");
    await expect(sendButton).toHaveCSS("border-radius", "50%");
    expect(await quick.evaluate(() => typeof window.zpi)).toBe("undefined");
    expect(await quick.evaluate(() => typeof window.zpiQuickChat.send)).toBe("function");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    await input.fill("第一行");
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("第一行\n");
    await expect.poll(async () => (await quickBounds())?.height ?? 0).toBeGreaterThan(44);
    const multilineBounds = await quickBounds();
    if (!multilineBounds) throw new Error("Missing multiline bounds");
    expect(multilineBounds.width).toBe(360);
    expect(multilineBounds.height).toBeLessThanOrEqual(184);
    expect(multilineBounds.y + multilineBounds.height).toBe(compactBottom);
    await input.fill("长草稿\n".repeat(20));
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 184 });
    await expect
      .poll(() => input.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await expect(input).toHaveCSS("overflow-y", "auto");
    expect((await quickBounds())?.y).toBe(compactBottom - 184);
    expect(server.requests).toHaveLength(0);
    await input.fill("只在浮窗回答");
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    expect((await quickBounds())?.y).toBe(compactBounds.y);
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    expect(await quick.evaluate(() => "setSelection" in window.zpiQuickChat)).toBe(false);
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect.poll(quickBounds).toMatchObject({ width: 660, height: 560 });
    await expect(quick.getByTestId("run")).toContainText("浮窗中的回复");
    await expect(quick.getByTestId("run")).toHaveCSS("padding-top", "8px");
    await expect(quick.getByTestId("run")).toHaveCSS("padding-bottom", "16px");
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "expanded");
    await expect(quick.locator(".quick-chat-header button")).toHaveCount(1);
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
    await expect(quick.getByRole("button", { name: /^(隐藏|关闭)$/ })).toHaveCount(0);
    expect(
      await quick.locator(".quick-chat-header").evaluate((header) => {
        const button = header.querySelector('button[aria-label="新对话"]');
        if (!button) return false;
        const headerBounds = header.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        return (
          buttonBounds.x >= headerBounds.x && buttonBounds.right < headerBounds.x + headerBounds.width / 2
        );
      }),
    ).toBe(true);
    await input.press("Escape");
    await quick.reload();
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect.poll(quickBounds).toMatchObject({ width: 660, height: 560 });
    finish.resolve();
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(quick.getByTestId("run")).toContainText("已经完成");
    await input.fill("展开后的长草稿\n".repeat(20));
    await expect(input).toHaveCSS("height", "160px");
    await expect(input).toHaveCSS("overflow-y", "auto");
    expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await quickBounds()).toMatchObject({ width: 660, height: 560 });
    await input.fill("第二轮");
    await expect(input).toHaveCSS("height", "24px");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveCount(2);
    await expect(quick.getByTestId("run").nth(1)).toHaveAttribute("data-status", "completed");
    await expect(quick.getByTestId("run").nth(1)).toHaveCSS("padding-top", "12px");
    await expect(quick.getByTestId("run").nth(1)).toHaveCSS("padding-bottom", "16px");
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
    await input.fill("新对话应清空草稿");
    await quick.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    await expect(input).toHaveValue("");
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
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
