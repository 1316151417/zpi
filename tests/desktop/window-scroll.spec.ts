import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("wheel and editor focus scroll only their viewport across drafts, conversations and side panes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-window-scroll-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  await writeFile(join(cwd, "preview.md"), "Preview\n\n".repeat(100));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "Long answer\n\n".repeat(100) }));
    done(response);
  });
  const app = await launchDesktop({ dir, url: server.url, project: cwd });
  try {
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    await expect(editor).toBeVisible();
    const headerTop = (await page.locator(".topbar").boundingBox())?.y;
    await expect(page.locator("body")).toHaveCSS("overflow", "hidden");
    const assertFixedWindow = async () => {
      expect(
        await page.evaluate(() => ({
          scroll: window.scrollY,
          top: document.querySelector(".shell")?.getBoundingClientRect().top,
          bottom: document.querySelector(".shell")?.getBoundingClientRect().bottom,
          viewport: innerHeight,
        })),
      ).toEqual({
        scroll: 0,
        top: 0,
        bottom: await page.evaluate(() => innerHeight),
        viewport: await page.evaluate(() => innerHeight),
      });
      await expect(page.locator(".sidebar-footer")).toBeInViewport();
      expect((await page.locator(".topbar").boundingBox())?.y).toBe(headerTop);
    };
    for (const size of [
      [1200, 800],
      [900, 640],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        size,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size[0]);
      await editor.fill("Long draft\n".repeat(80));
      await editor.press("Control+End");
      await editor.hover();
      await page.mouse.wheel(0, 3000);
      await assertFixedWindow();
      await page.mouse.wheel(0, -6000);
      await assertFixedWindow();
    }
    await editor.fill("@preview");
    await page.getByRole("option", { name: "preview.md", exact: true }).hover();
    await page.mouse.wheel(0, -4000);
    await assertFixedWindow();
    await editor.press("Escape");
    await editor.fill("Generate a long answer");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const conversation = page.locator(".conversation");
    await conversation.hover();
    await page.mouse.wheel(0, -10000);
    await expect.poll(() => conversation.evaluate((el) => el.scrollTop)).toBe(0);
    await assertFixedWindow();
    await page.mouse.wheel(0, 10000);
    await expect.poll(() => conversation.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await assertFixedWindow();
    await editor.fill("@preview");
    await page.getByRole("option", { name: "preview.md", exact: true }).click();
    await editor.locator(".inline-mention.file").click();
    await expect(page.getByRole("tab", { name: "preview.md", exact: true })).toBeVisible();
    const pane = page.locator(".right-pane");
    await pane.hover();
    await page.mouse.wheel(0, 10000);
    await page.mouse.wheel(0, -10000);
    await editor.focus();
    await assertFixedWindow();
    await page.screenshot({ path: "test-results/window-scroll-contained.png" });
  } finally {
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
