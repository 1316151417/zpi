import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("side chats fit narrow panes and add selected text to their own draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-chat-layout-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "可以引用的辅助回答" }));
    done(response);
  });
  const app = await launchDesktop({ dir, url: server.url });
  try {
    const page = await app.firstWindow();
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("主问题");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await main.getByLabel("消息", { exact: true }).fill("保留主草稿");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await expect(side).toBeVisible();
    for (const size of [
      [1200, 800],
      [900, 640],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        size,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size[0]);
      await expect
        .poll(() => side.locator(".conversation").evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBe(0);
      await expect(side.getByLabel("消息", { exact: true })).toBeInViewport();
    }
    await side.getByLabel("消息", { exact: true }).fill("辅助问题");
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await side.getByLabel("消息", { exact: true }).fill("保留辅助草稿");
    const paragraph = side.locator(".answer p");
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const menu = page.getByRole("toolbar", { name: "选文操作", exact: true });
    await menu.getByRole("button", { name: "添加到当前辅助对话", exact: true }).click();
    await expect(side.getByLabel("消息", { exact: true })).toBeFocused();
    await expect(side.getByLabel("消息", { exact: true })).toHaveText("保留辅助草稿");
    await expect(side.locator(".selection-reference-chip")).toHaveAttribute(
      "data-conversation-selection-reference-count",
      "1",
    );
    await expect(main.getByLabel("消息", { exact: true })).toHaveText("保留主草稿");
    await expect(main.locator(".selection-reference-chip")).toHaveCount(0);
    await page.screenshot({ path: "test-results/side-chat-selection.png" });
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("# userselect:");
    expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("可以引用的辅助回答");
  } finally {
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("task and pane headers keep window drag regions outside controls while find is open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-titlebar-find-"));
  const app = await launchDesktop({ dir, url: "" });
  try {
    const page = await app.firstWindow();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator("main").getByLabel("消息", { exact: true }).press("Control+f");
    const find = page.getByRole("dialog", { name: "在任务中查找", exact: true });
    await expect(find).toBeVisible();
    for (const selector of [".topbar", ".pane-header"]) {
      await expect(page.locator(selector)).toHaveCSS("app-region", "drag");
      const header = await page.locator(selector).boundingBox();
      const overlay = await find.boundingBox();
      expect(header && overlay && header.y + header.height <= overlay.y).toBe(true);
    }
    await expect(page.locator(".desktop-top-controls")).toHaveCSS("app-region", "no-drag");
    await expect(page.getByLabel("收起右侧栏", { exact: true })).toHaveCSS("app-region", "no-drag");
    await expect(find).toHaveCSS("app-region", "no-drag");
    await find.getByRole("button", { name: "关闭查找", exact: true }).click();
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeHidden();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
