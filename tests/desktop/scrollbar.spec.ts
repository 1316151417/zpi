import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

// Inspect rendered pixels: native scrollbar fade/hover states have no DOM attributes.
async function scrollbarPixels(page: Page, area: Locator, reference: number[]) {
  const box = await area.boundingBox();
  if (!box) throw Error("Missing conversation viewport");
  const scale = await page.evaluate(() => devicePixelRatio);
  const { data, info } = await sharp(
    await page.screenshot({
      clip: { x: box.x + box.width - 24, y: box.y + 2, width: 23, height: box.height - 4 },
    }),
  )
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let columns = 0;
  let targetPixels = 0;
  for (let x = 0; x < info.width; x++) {
    let colored = 0;
    for (let y = 0; y < info.height; y++) {
      const offset = (y * info.width + x) * info.channels;
      const [r, g, b] = data.subarray(offset, offset + 3);
      if (r < 247 && Math.abs(r - g) < 2 && Math.abs(g - b) < 2) colored++;
      if (r === reference[0] && g === reference[1] && b === reference[2]) targetPixels++;
    }
    if (colored > 8) columns++;
  }
  return { width: columns / scale, targetPixels };
}

test("native conversation scrollbar matches ZCode alpha compositing, expands, fades and remains draggable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-scrollbar-"));
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        content: Array.from(
          { length: 100 },
          (_, index) => `第 ${index + 1} 段：验证原生滚动条，不改变会话内容或阅读位置。`,
        ).join("\n\n"),
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    const input = page.getByLabel("消息", { exact: true });
    await input.fill("生成长会话");
    await input.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const area = page.locator(".conversation");
    await expect(area).toHaveCSS("scrollbar-color", "rgba(13, 13, 13, 0.1) rgba(0, 0, 0, 0)");
    await expect(area).toHaveCSS("scrollbar-width", "auto");
    expect(
      await area.evaluate((el) => (el instanceof HTMLElement ? el.offsetWidth - el.clientWidth : null)),
    ).toBe(0);
    // Render ZCode's translucent border over its background with the same compositor.
    // Monitor-native RGB readings are profile-dependent and must not become opaque CSS colors.
    await page.evaluate(() => {
      const chip = document.createElement("div");
      chip.id = "zcode-scrollbar-reference";
      chip.style.cssText =
        "position:fixed;left:0;top:200px;width:8px;height:8px;background:#f8f8f8;z-index:100";
      const ink = document.createElement("div");
      ink.style.cssText = "width:100%;height:100%;background:rgba(13,13,13,.1)";
      chip.append(ink);
      document.body.append(chip);
    });
    const reference = [
      ...(await sharp(await page.locator("#zcode-scrollbar-reference").screenshot())
        .extract({ left: 2, top: 2, width: 1, height: 1 })
        .removeAlpha()
        .raw()
        .toBuffer()),
    ];
    await page.locator("#zcode-scrollbar-reference").evaluate((el) => el.remove());
    const box = await area.boundingBox();
    if (!box) throw Error("Missing conversation viewport");
    await area.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(0, 500);
    await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    await expect
      .poll(async () => (await scrollbarPixels(page, area, reference)).targetPixels)
      .toBeGreaterThan(100);
    const thin = await scrollbarPixels(page, area, reference);
    await page.screenshot({ path: "test-results/scrollbar-thin.png" });
    const thumbY = await area.evaluate(
      (el) =>
        el.getBoundingClientRect().y +
        ((el.scrollTop + el.clientHeight / 2) * el.clientHeight) / el.scrollHeight,
    );
    await page.mouse.move(box.x + box.width - 3, thumbY);
    await expect
      .poll(async () => (await scrollbarPixels(page, area, reference)).width)
      .toBeGreaterThan(thin.width);
    await page.screenshot({ path: "test-results/scrollbar-hover.png" });
    const before = await area.evaluate((el) => el.scrollTop);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 3, thumbY + 40, { steps: 4 });
    await page.mouse.up();
    await expect.poll(() => area.evaluate((el) => el.scrollTop)).toBeGreaterThan(before + 100);
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const reading = await area.evaluate((el) => el.scrollTop);
    const hiddenAt = Date.now();
    await expect
      .poll(async () => (await scrollbarPixels(page, area, reference)).width, {
        timeout: 2500,
        intervals: [200],
      })
      .toBe(0);
    expect(Date.now() - hiddenAt).toBeLessThan(2500);
    expect(await area.evaluate((el) => el.scrollTop)).toBe(reading);
    await page.screenshot({ path: "test-results/scrollbar-hidden.png" });
    await page.mouse.wheel(0, 150);
    await expect
      .poll(async () => (await scrollbarPixels(page, area, reference)).targetPixels)
      .toBeGreaterThan(100);
    expect((await scrollbarPixels(page, area, reference)).width).toBe(thin.width);
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(area).toHaveCSS("scrollbar-color", "rgba(255, 255, 255, 0.1) rgba(0, 0, 0, 0)");
    await expect(area).toHaveCSS("scrollbar-width", "auto");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
