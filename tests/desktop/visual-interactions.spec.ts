import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("task menus and dialogs share ZCode surfaces, enter and exit without losing focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-visual-interactions-"));
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
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
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
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
