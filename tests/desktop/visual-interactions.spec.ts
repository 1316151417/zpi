import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("task menus and dialogs share ZCode surfaces, enter and exit without losing focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-visual-interactions-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "完成" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("检查菜单");
    await editor.press("Enter");
    await expect(page.locator(".answer")).toContainText("完成");
    const trigger = page.locator(".topbar .task-more");
    await trigger.click();
    const menu = page.locator(".task-menu");
    await expect(menu).toHaveCSS("border-radius", "8px");
    await expect(menu).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(menu).toHaveCSS(
      "box-shadow",
      "rgba(0, 0, 0, 0.1) 0px 4px 6px -1px, rgba(0, 0, 0, 0.1) 0px 2px 4px -2px",
    );
    await expect(menu).toHaveCSS("animation-duration", "0.1s");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(menu).toHaveCSS("background-color", "rgb(43, 43, 43)");
    await expect(page.locator(".composer")).toHaveCSS("background-color", "rgb(43, 43, 43)");
    await page.evaluate(async () => {
      await Promise.allSettled(
        document
          .getAnimations()
          .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
          .map((animation) => animation.finished),
      );
    });
    await page.screenshot({ path: "test-results/zcode-task-menu-dark.png" });
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "重命名任务", exact: true });
    await expect(dialog).toHaveCSS("border-radius", "16px");
    await expect(dialog).toHaveCSS("background-color", "rgb(43, 43, 43)");
    await expect(dialog).toHaveCSS("animation-duration", "0.1s");
    await expect(page.locator(".modal-backdrop")).toHaveCSS("backdrop-filter", "blur(4px)");
    const name = dialog.getByRole("textbox", { name: "名称", exact: true });
    const cancel = dialog.getByRole("button", { name: "取消", exact: true });
    const confirm = dialog.getByRole("button", { name: "确认", exact: true });
    const close = dialog.getByRole("button", { name: "关闭", exact: true });
    await expect(name).toBeFocused();
    await expect(name).toHaveCSS("background-color", "rgb(43, 43, 43)");
    await expect(cancel).toHaveCSS("background-color", "rgb(54, 54, 54)");
    await dialog.screenshot({ path: "test-results/zcode-task-rename-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(dialog).toHaveCSS("width", "576px");
    await expect(dialog.locator("form")).toHaveCSS("padding", "24px");
    await expect(dialog.locator("form")).toHaveCSS("gap", "24px");
    await expect(dialog.locator("label")).toHaveCount(0);
    await expect(dialog.getByRole("heading")).toHaveCSS("font-weight", "500");
    await expect(name).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await expect(name).toHaveCSS("height", "32px");
    await expect(name).toHaveCSS("border-radius", "8px");
    await expect(cancel).toHaveCSS("background-color", "rgb(230, 230, 230)");
    await expect(confirm).toHaveCSS("background-color", "rgb(0, 0, 0)");
    for (const button of [cancel, confirm]) {
      await expect(button).toHaveCSS("height", "40px");
      await expect(button).toHaveCSS("padding", "0px 20px");
      await expect(button).toHaveCSS("border-radius", "8px");
    }
    await expect(close).toHaveCSS("width", "24px");
    await expect(close.locator("svg")).toHaveCSS("width", "12px");
    await name.fill("zcodex命令有几个commands?");
    await name.dispatchEvent("compositionstart");
    await name.dispatchEvent("keydown", { key: "Enter", isComposing: false });
    await expect(dialog).toBeVisible();
    await name.dispatchEvent("compositionend");
    await page.screenshot({ path: "test-results/zcode-task-rename-light.png" });
    await dialog.screenshot({ path: "test-results/task-rename-dialog.png" });
    await close.click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    await expect(name).not.toHaveValue("zcodex命令有几个commands?");
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    await name.fill("重命名后的任务");
    await name.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(page.locator(".topbar-title")).toHaveText("重命名后的任务");
    await trigger.click();
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    await name.fill("确认按钮重命名");
    await confirm.click();
    await expect(dialog).toBeHidden();
    await expect(page.locator(".topbar-title")).toHaveText("确认按钮重命名");
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await trigger.click();
    await expect(menu).toHaveCSS("animation-name", "none");
    await page.keyboard.press("Escape");
    await page.getByLabel("收起侧边栏", { exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.getByLabel("展开侧边栏", { exact: true }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect(page.locator(".sidebar")).toHaveCSS("transition-duration", "0s");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
