import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("desktop automation renders and accepts input without showing or focusing its window", async () => {
  test.skip(process.env.ZPI_TEST_SHOW_WINDOW === "1", "Visible debugging was explicitly requested");
  const dir = await mkdtemp(join(tmpdir(), "ZPI-hidden-window-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const presentation = () =>
      app?.evaluate(({ app, BrowserWindow }) => ({
        visible: BrowserWindow.getAllWindows()[0].isVisible(),
        focused: BrowserWindow.getAllWindows()[0].isFocused(),
        throttled: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
        dock: process.platform === "darwin" ? app.dock?.isVisible() : false,
      }));
    expect(await presentation()).toEqual({ visible: false, focused: false, throttled: false, dock: false });
    await page.getByLabel("新建任务", { exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("隐藏测试");
    await editor.press("End");
    await page.keyboard.type("仍可输入");
    await expect(editor).toHaveText("隐藏测试仍可输入");
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.screenshot({ path: "test-results/hidden-window.png" });
    await app.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
    expect(await presentation()).toEqual({ visible: false, focused: false, throttled: false, dock: false });
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
