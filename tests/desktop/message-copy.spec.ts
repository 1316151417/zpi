import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator } from "@playwright/test";
import sharp from "sharp";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

type ImageMenu = {
  select?: () => void;
  point?: { x: number; y: number };
};

test("message context menus copy a complete link and target the displayed image at both sizes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-message-copy-"));
  const project = join(dir, "project");
  await mkdir(project);
  const attachment = join(dir, "attachment.png");
  await sharp({ create: { width: 72, height: 72, channels: 3, background: "white" } })
    .png()
    .toFile(attachment);
  await sharp({ create: { width: 240, height: 240, channels: 3, background: "black" } })
    .png()
    .toFile(join(project, "qr.png"));
  const url = "https://example.com/auth?redirect=%2Fpath&state=sample#confirm";
  const tableUrl = "https://example.com/docs#table";
  const model = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        content: `[打开授权页面](${url})\n\n![二维码](./qr.png)\n\n| 地址 |\n| --- |\n| [表格链接](${tableUrl}) |`,
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    const desktop = await launchDesktop({ dir, project, url: model.url, images: [attachment] });
    app = desktop;
    const page = await desktop.firstWindow();
    await page.evaluate(async () => {
      const settings = await window.zpi.getSettings();
      if (!settings.ok) throw Error(settings.error.message);
      const { id, name, baseUrl, models } = settings.value.providers[0];
      const result = await window.zpi.saveProvider({
        id,
        name,
        baseUrl,
        apiKey: "local-test-key",
        models: models.map((model) => ({ ...model, input: ["text", "image"] })),
      });
      if (!result.ok) throw Error(result.error.message);
    });
    await desktop.evaluate(({ BrowserWindow, Menu }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const contents = window.webContents;
      const imageMenu: ImageMenu = {};
      Object.assign(globalThis, { imageMenu });
      // Keep the desktop launcher isolated. Exercise the actual menu item, stopping at the OS clipboard.
      contents.copyImageAt = (x, y) => {
        imageMenu.point = { x, y };
      };
      const popup = Menu.prototype.popup;
      Menu.prototype.popup = function (options) {
        const [item] = this.items;
        if (options?.window !== window || this.items.length !== 1 || item.label !== "复制图片") {
          popup.call(this, options);
          return;
        }
        imageMenu.select = () => item.click({}, window, contents);
      };
    });

    const copyImage = async (image: Locator) => {
      await expect
        .poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth))
        .toBeGreaterThan(0);
      await image.click({ button: "right" });
      await expect
        .poll(() =>
          desktop.evaluate(() =>
            Boolean((globalThis as typeof globalThis & { imageMenu: ImageMenu }).imageMenu.select),
          ),
        )
        .toBe(true);
      const point = await desktop.evaluate(() => {
        const { imageMenu } = globalThis as typeof globalThis & { imageMenu: ImageMenu };
        imageMenu.point = undefined;
        imageMenu.select?.();
        imageMenu.select = undefined;
        return imageMenu.point;
      });
      if (!point) throw new Error("The menu did not call Electron's image clipboard API");
      const copiedSrc = await page.evaluate(
        ({ x, y }) => (document.elementFromPoint(x, y) as HTMLImageElement | null)?.currentSrc,
        point,
      );
      expect(copiedSrc).toBe(await image.evaluate((element: HTMLImageElement) => element.currentSrc));
    };

    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("添加上下文", { exact: true }).click();
    await page.getByRole("option", { name: "附件", exact: true }).click();
    await expect(page.locator(".composer .image-chip img")).toHaveCount(1);
    const composer = page.getByLabel("消息", { exact: true });
    await composer.fill("展示链接和图片");
    await composer.press("Enter");
    const run = page.getByTestId("run");
    await expect(run).toHaveAttribute("data-status", "completed");
    const link = run.getByRole("button", { name: "打开授权页面", exact: true });
    await link.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText(["打开", "在浏览器中打开", "复制链接"]);
    await page.getByRole("menuitem", { name: "复制链接", exact: true }).click();
    await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(url);
    await expect(page.getByLabel("浏览器地址")).toHaveCount(0);
    await run.getByRole("button", { name: "预览表格", exact: true }).click();
    const table = page.getByRole("dialog", { name: "表格预览", exact: true });
    await table.getByRole("button", { name: "表格链接", exact: true }).click({ button: "right" });
    await table.getByRole("menuitem", { name: "复制链接", exact: true }).click();
    await expect.poll(() => desktop.evaluate(({ clipboard }) => clipboard.readText())).toBe(tableUrl);
    await table.getByRole("button", { name: "关闭表格预览", exact: true }).click();

    const answerImage = run.getByRole("img", { name: "二维码", exact: true });
    const preview = page.getByRole("dialog", { name: "图片预览", exact: true });
    await copyImage(answerImage);
    await expect(preview).toHaveCount(0);
    await answerImage.click();
    await preview.getByRole("button", { name: "放大", exact: true }).click();
    await copyImage(preview.getByRole("img", { name: "二维码", exact: true }));
    await expect(preview).toBeVisible();
    await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();

    const userImage = run.locator(".message-images").getByRole("img", { name: "attachment.png" });
    await copyImage(userImage);
    await userImage.click();
    await copyImage(preview.getByRole("img", { name: "attachment.png" }));
  } finally {
    await runCleanup([
      () => app?.close(),
      () => model.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
