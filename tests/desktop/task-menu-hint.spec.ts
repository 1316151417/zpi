import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("restored task-menu focus does not reopen its hint, but hover still does", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-menu-hint-"));
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
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("检查任务菜单提示");
    await editor.press("Enter");
    await expect(page.locator(".answer")).toContainText("完成");
    const trigger = page.getByLabel("任务菜单", { exact: true });

    await trigger.click();
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "重命名任务", exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "取消", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await trigger.hover();
    await expect(page.getByRole("tooltip")).toContainText("任务菜单");
    // Step across the hint's grace area so Radix sees the pointer leave.
    await page.mouse.move(0, 0, { steps: 5 });
    await expect(page.getByRole("tooltip")).toHaveCount(0);

    await editor.focus();
    await page.keyboard.press("Meta+U");
    await expect(page.getByRole("menu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("task-menu shortcuts stay disabled throughout full view and recover on exit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-full-view-task-menu-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "完成" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    const editor = page.getByLabel("消息", { exact: true });
    const menu = page.locator(".task-menu");
    await editor.fill("完整视图任务菜单");
    await editor.press("Enter");
    await expect(page.locator(".answer")).toContainText("完成");
    const expectTaskMenuDisabled = async () => {
      await page.keyboard.press(`${primary}+u`);
      await app?.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0].webContents.send("zpi:shortcut", "task-menu");
      });
      // Wait for both DOM and forwarded native commands to reach React before checking absence.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      await expect(menu).toHaveCount(0);
    };

    await page.getByTestId("right-sidebar-toggle").click();
    await page.getByLabel("进入完整视图", { exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-floating/);
    await expectTaskMenuDisabled();
    await page.locator(".pane-conversation-tab").click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-conversation/);
    await expectTaskMenuDisabled();
    await page.getByRole("tab", { name: "新标签页", exact: true }).click();
    await editor.focus();
    await page.getByLabel("展开消息", { exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-float-expanded/);
    await expectTaskMenuDisabled();
    await page.getByLabel("最小化编辑器", { exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-float-minimized/);
    await expectTaskMenuDisabled();
    await page.getByLabel("退出完整视图", { exact: true }).click();
    await expect(page.getByLabel("任务菜单", { exact: true })).toBeVisible();
    await expect(menu).toHaveCount(0);
    await editor.press(`${primary}+u`);
    await expect(menu).toBeVisible();
    await page.keyboard.press(`${primary}+u`);
    await expect(menu).toHaveCount(0);
    await expect(editor).toBeFocused();
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
