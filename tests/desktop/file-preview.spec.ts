import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("file references share icons and canonical text; chat files open reusable sidebar previews", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-file-references-"));
  const project = join(dir, "中文 项目");
  await mkdir(project);
  const config = join(project, "订单 汇总.json");
  await writeFile(config, '{"project":"ZPI references","orders":42}\n');
  const workbook = join(project, "模型数据.xlsx");
  await writeFile(workbook, await readFile(resolve("tests/fixtures/references.xlsx")));
  const skill = join(dir, ".agents", "skills", "review", "SKILL.md");
  await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
  await writeFile(skill, "---\nname: review\ndescription: Review code\n---\nReview");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[订单 汇总.json](<${config}>)\n\n[模型数据.xlsx](<${workbook}>)` }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("@订单");
    await expect(page.getByRole("option").locator("img")).toHaveAttribute(
      "src",
      /material-icons\/json\.svg$/,
    );
    await page.getByRole("option").click();
    const file = editor.locator(".inline-mention.file");
    await expect(file).toHaveText("订单 汇总.json");
    await expect(file).toHaveCSS("color", "rgb(26, 112, 184)");
    await file.click();
    await expect(page.getByRole("tab", { name: "订单 汇总.json", exact: true })).toBeVisible();
    await expect(page.locator(".file-text-preview")).toContainText("ZPI references");
    const canonical = `检查 [订单 汇总.json](<${config}>)\n/init\n/compact\n[$review](${skill})`;
    await editor.fill(canonical);
    await expect(editor.locator(".inline-mention.command")).toHaveText(["Init", "Compact"]);
    await expect(editor.locator(".inline-mention.skill")).toHaveCSS("color", "rgb(116, 83, 176)");
    await editor.press("Meta+A");
    const copied = await editor.evaluate((element) => {
      const data = new DataTransfer();
      element.dispatchEvent(
        new ClipboardEvent("copy", { clipboardData: data, bubbles: true, cancelable: true }),
      );
      return data.getData("text/plain");
    });
    expect(copied).toBe(canonical);
    await editor.press("ArrowRight");
    await page.screenshot({ path: "test-results/desktop-references-light.png" });
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".user-message-text .inline-mention.command")).toHaveText(["Init", "Compact"]);
    const answer = page.locator(".answer");
    await answer.getByRole("button", { name: "订单 汇总.json", exact: true }).click();
    await expect(page.getByRole("tab", { name: "订单 汇总.json", exact: true })).toHaveCount(1);
    await answer.getByRole("button", { name: "模型数据.xlsx", exact: true }).click();
    await expect(page.getByRole("tab", { name: "模型数据.xlsx", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "模型数据", exact: true })).toBeVisible();
    await expect(page.locator('[data-office-preview-kind="excel"] canvas').first()).toBeVisible();
    await expect(page.locator('[data-office-preview-kind="excel"] [role=alert]')).toHaveCount(0);
    await page.getByRole("tab", { name: "图表数据", exact: true }).click();
    await expect(page.getByRole("tab", { name: "图表数据", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.screenshot({ path: "test-results/desktop-references-xlsx.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(answer.locator(".inline-mention.file").first()).toHaveCSS("color", "rgb(128, 190, 255)");
    await page.screenshot({ path: "test-results/desktop-references-dark.png" });
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("embedded file images retain their preview across theme changes and reload on refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-file-images-"));
  const project = join(dir, "project");
  await mkdir(project);
  const image = join(project, "image.svg");
  const svg = (width: number) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20"><rect width="100%" height="100%" fill="red"/></svg>`;
  await writeFile(image, svg(40));
  await writeFile(join(project, "README.md"), "# Preview\n\n![image](./image.svg)");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "[预览](./README.md)" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("预览图片");
    await editor.press("Enter");
    await page.locator(".answer").getByRole("button", { name: "预览", exact: true }).click();
    const rendered = page.locator(".file-markdown-preview img[data-streamdown=image]");
    const width = () => rendered.evaluate((element: HTMLImageElement) => element.naturalWidth);
    await expect.poll(width).toBe(40);
    await writeFile(image, svg(60));
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    expect(await width()).toBe(40);
    await page.getByRole("button", { name: "刷新文件", exact: true }).click();
    await expect.poll(width).toBe(60);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
