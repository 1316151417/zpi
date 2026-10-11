import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("tables use theme borders and support Markdown copy, CSV, preview and horizontal scrolling; prose and image previews remain interactive", async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-table-"));
  const project = join(dir, "project");
  await mkdir(project);
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="176"><rect width="240" height="176" fill="#4c8ee8"/><circle cx="120" cy="88" r="48" fill="white"/></svg>';
  await writeFile(join(project, "image.svg"), svg);
  const images = createServer((req, response) => {
    if (req.url === "/image.svg") response.setHeader("content-type", "image/svg+xml").end(svg);
    else response.writeHead(404).end();
  });
  images.listen(0, "127.0.0.1");
  await once(images, "listening");
  const imageUrl = `http://127.0.0.1:${(images.address() as AddressInfo).port}/image.svg`;
  const tableText =
    "| 语言 | 类型系统 | 首次发布 | 主要用途 |\n| --- | --- | --- | --- |\n| Python | 动态 | 1991 | 数据科学、脚本、Web |\n| Go | 静态 | 2009 | 后端服务、云原生 |\n| Rust | 静态 | 2015 | 系统编程、高性能场景 |\n| TypeScript | 静态 | 2012 | 前端、全栈开发 |";
  const wideText = `| ${Array.from({ length: 10 }, (_, i) => `列${i}`).join(" | ")} |\n| ${Array(10).fill("---").join(" | ")} |\n| ${Array(10).fill("这一列用于验证超宽表格可以横向滚动且不会撑破对话布局").join(" | ")} |`;
  const markdown = `## Markdown 输出\n\n中文**加粗**和~普通波浪线~，~~删除~~，公式 $x^2$，价格 $5 to $10。\n\n> 引用文字\n\n- 第一项\n- 第二项\n\n${tableText}\n\n${wideText}\n\n![本地图片](image.svg)\n\n![远程图片](${imageUrl})\n\n![失败图片](${imageUrl}/missing)`;
  const server = await fakeServer((_body, response) => {
    send(response, chunk({ content: markdown }));
    done(response);
  });
  const app = await launchDesktop({ dir, project, url: server.url });
  const oldClipboard = await app.evaluate(({ clipboard }) => clipboard.readText());
  try {
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("展示 Markdown");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const blocks = page.locator(".markdown-table-block");
    await expect(blocks).toHaveCount(2);
    const table = blocks.first();
    await expect(table.locator("th")).toHaveCount(4);
    await expect(table.locator("tbody tr")).toHaveCount(4);
    const appearance = await table.evaluate((element) => {
      const border = getComputedStyle(element.querySelector(".markdown-table-border") as Element);
      const header = getComputedStyle(element.querySelector("th") as Element);
      const cell = getComputedStyle(element.querySelector("td") as Element);
      return {
        border: border.borderColor,
        radius: border.borderRadius,
        weight: header.fontWeight,
        cellBorder: cell.borderRightWidth,
        padding: cell.padding,
      };
    });
    expect(appearance).toEqual({
      border: "rgba(13, 13, 13, 0.1)",
      radius: "12px",
      weight: "400",
      cellBorder: "0px",
      padding: "8px 12px",
    });
    await table.getByRole("button", { name: "复制 Markdown", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(tableText);
    const csvPath = join(dir, "table.csv");
    await app.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) => item.setSavePath(path));
    }, csvPath);
    await table.getByRole("button", { name: "下载 CSV", exact: true }).click();
    await expect
      .poll(async () => readFile(csvPath, "utf8").catch(() => ""))
      .toBe(
        "\uFEFF语言,类型系统,首次发布,主要用途\r\nPython,动态,1991,数据科学、脚本、Web\r\nGo,静态,2009,后端服务、云原生\r\nRust,静态,2015,系统编程、高性能场景\r\nTypeScript,静态,2012,前端、全栈开发",
      );
    const opener = table.getByRole("button", { name: "预览表格", exact: true });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "表格预览", exact: true });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator("tbody tr")).toHaveCount(4);
    expect(
      await dialog
        .locator("th")
        .first()
        .evaluate((el) => getComputedStyle(el).position),
    ).toBe("sticky");
    await page.keyboard.press("Escape");
    await expect(dialog).toHaveCount(0);
    await expect(opener).toBeFocused();
    const wide = blocks.last();
    await wide.scrollIntoViewIfNeeded();
    const range = wide.getByRole("slider", { name: "表格横向滚动" });
    await expect(range).toBeVisible();
    await range.focus();
    await range.press("End");
    await expect
      .poll(() => wide.locator(".markdown-table-scroll").evaluate((el) => el.scrollLeft))
      .toBeGreaterThan(0);
    await expect(wide.locator('[data-markdown-table-edge-shadow="left"]')).toBeVisible();
    expect(
      await page
        .locator(".markdown-body strong")
        .first()
        .evaluate((el) => getComputedStyle(el).fontWeight),
    ).toBe("500");
    await expect(page.locator(".markdown-body del")).toHaveText("删除");
    await expect(page.locator(".katex")).toHaveCount(1);
    await expect(page.locator(".markdown-body")).toContainText("~普通波浪线~");
    await table.scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/markdown-table-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => table.locator(".markdown-table-border").evaluate((el) => getComputedStyle(el).borderColor))
      .toBe("rgba(255, 255, 255, 0.1)");
    await page.screenshot({ path: "test-results/markdown-table-dark.png" });
    const gallery = page.locator(".markdown-image-gallery");
    await expect(gallery).toBeVisible();
    await expect(gallery.getByRole("button", { name: "打开图片预览" })).toHaveCount(2);
    await expect(gallery.getByRole("button", { name: "打开图片预览" }).first()).toBeEnabled();
    await expect(gallery.getByRole("button", { name: "打开图片预览" }).nth(1)).toBeEnabled();
    await expect(page.getByRole("button", { name: "图片无法显示" })).toBeDisabled();
    await gallery.getByRole("button", { name: "打开图片预览" }).first().click();
    const imagePreview = page.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(imagePreview).toBeVisible();
    await expect(imagePreview).toContainText("1 / 2");
    await imagePreview.getByRole("button", { name: "下一张图片" }).click();
    await expect(imagePreview).toContainText("2 / 2");
    await imagePreview.getByRole("button", { name: "放大", exact: true }).click();
    await expect(imagePreview.locator(".markdown-image-canvas img")).toHaveAttribute(
      "style",
      /scale\(1.25\)/,
    );
    await imagePreview.getByRole("button", { name: "关闭图片预览" }).click();
    await gallery.getByRole("button", { name: "打开图片预览" }).first().click();
    const localImagePath = join(dir, "local-image.svg");
    await app.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) => item.setSavePath(path));
    }, localImagePath);
    await imagePreview.getByRole("link", { name: "下载图片" }).click();
    await expect.poll(async () => readFile(localImagePath, "utf8").catch(() => "")).toBe(svg);
    await imagePreview.getByRole("button", { name: "下一张图片" }).click();
    const remoteImagePath = join(dir, "remote-image.svg");
    await app.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) => item.setSavePath(path));
    }, remoteImagePath);
    await imagePreview.getByRole("link", { name: "下载图片" }).click();
    await expect.poll(async () => readFile(remoteImagePath, "utf8").catch(() => "")).toBe(svg);
    await imagePreview.getByRole("button", { name: "关闭图片预览" }).click();
    const rejected = await page.evaluate(async () => [
      await window.zpi.downloadImage("file:///etc/hosts"),
      await window.zpi.downloadImage("javascript:alert(1)"),
      await window.zpi.downloadImage("data:text/html;base64,YQ=="),
    ]);
    expect(rejected.every((result) => !result.ok)).toBe(true);
    const expand = wide.getByRole("button", { name: "展开表格滚动区域", exact: true });
    await expand.click();
    await expect(wide.getByRole("button", { name: "收回表格滚动区域", exact: true })).toBeVisible();
    await wide.getByRole("button", { name: "收回表格滚动区域", exact: true }).click();
    expect(errors).toEqual([]);
  } finally {
    await app.evaluate(({ clipboard }, text) => clipboard.writeText(text), oldClipboard);
    await app.close();
    await server.close();
    images.closeAllConnections();
    await new Promise<void>((resolve) => images.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
