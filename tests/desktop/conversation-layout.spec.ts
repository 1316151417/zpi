import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("ZCode turn actions stay near the composer and share the turn hover area at every column width", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-conversation-layout-"));
  const text = Array.from(
    { length: 45 },
    (_, index) => `第 ${index + 1} 段：检查正文、操作栏和输入栏的布局。`,
  ).join("\n\n");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: text }));
    done(response);
  });
  const app = await launchDesktop({ dir, url: server.url });
  try {
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("检查消息布局");
    await page.getByLabel("发送", { exact: true }).click();
    const run = page.getByTestId("run");
    const area = page.locator(".conversation");
    const actions = run.locator(".assistant-message-actions");
    await expect(run).toHaveAttribute("data-status", "completed");
    for (const [width, height] of [
      [1200, 800],
      [900, 640],
      [1600, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        [width, height],
      );
      await area.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const row = document.querySelector(".assistant-message-actions");
            const composer = document.querySelector(".composer-container > .composer-stack > .composer");
            if (!row || !composer) throw new Error("Missing message actions or composer");
            return composer.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
          }),
        )
        .toBe(20);
      const geometry = await page.evaluate(() => {
        const body = document.querySelector(".task-body");
        const column = document.querySelector(".conversation-inner");
        const dock = document.querySelector(".composer-container");
        const answer = document.querySelector(".assistant-message-row > .answer");
        const input = document.querySelector(".composer-container > .composer-stack > .composer");
        if (!body || !column || !dock || !answer || !input) throw new Error("Missing conversation layout");
        return {
          paneWidth: body.getBoundingClientRect().width,
          columnWidth: column.getBoundingClientRect().width,
          dockWidth: dock.getBoundingClientRect().width,
          columnLeft: column.getBoundingClientRect().left,
          dockLeft: dock.getBoundingClientRect().left,
          textInset: answer.getBoundingClientRect().left - column.getBoundingClientRect().left,
          inputInset: input.getBoundingClientRect().left - dock.getBoundingClientRect().left,
        };
      });
      const expectedWidth =
        geometry.paneWidth >= 1280
          ? Math.min(geometry.paneWidth - 384, 1152)
          : geometry.paneWidth >= 864
            ? Math.min(geometry.paneWidth - 96, 896)
            : geometry.paneWidth;
      expect(geometry.columnWidth).toBe(expectedWidth);
      expect(geometry.dockWidth).toBe(expectedWidth);
      expect(geometry.columnLeft).toBe(geometry.dockLeft);
      expect(geometry.textInset).toBe(geometry.paneWidth >= 448 ? 24 : 16);
      expect(geometry.inputInset).toBe(16);
      await page.mouse.move(0, 0);
      await expect(actions).toHaveCSS("opacity", "0");
      const input = await page.locator(".composer-container > .composer-stack > .composer").boundingBox();
      const row = await actions.boundingBox();
      if (!input || !row) throw new Error("Missing action hover target");
      // Moving just above the 20px turn footer must hit the full action row.
      await page.mouse.move(row.x + 12, input.y - 21);
      await expect(actions).toHaveCSS("opacity", "1");
      await page.screenshot({ path: `test-results/conversation-footer-${width}.png` });
    }
    await run.getByTestId("progress").scrollIntoViewIfNeeded();
    await run.getByTestId("progress").hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await actions.getByLabel("复制", { exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
    await page.getByLabel("消息", { exact: true }).focus();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await actions.getByLabel("复制", { exact: true }).focus();
    await expect(actions).toHaveCSS("opacity", "1");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/conversation-footer-dark.png" });
  } finally {
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
