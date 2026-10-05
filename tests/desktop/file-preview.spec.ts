import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("conversation files and folders share ZCode menus; folders open in Finder and files use the sidebar", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-conversation-file-menu-")));
  const project = join(dir, "中文 项目");
  const folder = join(project, "资料 目录");
  await mkdir(folder, { recursive: true });
  const file = join(folder, "订单 %20 #1.json");
  await writeFile(file, '{"preview":"订单文件"}\n');
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        content: [
          `[文件](<${pathToFileURL(file).href}#L1>)`,
          `[资料目录](<${folder}/>)`,
          "[相对目录](<./资料 目录/>)",
          `[文件 URL 目录](${pathToFileURL(folder).href})`,
        ].join("\n\n"),
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ shell }) => {
      const calls: { action: string; path: string }[] = [];
      (globalThis as typeof globalThis & { fileMenuCalls: typeof calls }).fileMenuCalls = calls;
      shell.openPath = async (path) => {
        calls.push({ action: "open", path });
        return "";
      };
      shell.showItemInFolder = (path) => {
        calls.push({ action: "reveal", path });
      };
    });
    const calls = () =>
      app?.evaluate(() => (globalThis as typeof globalThis & { fileMenuCalls: unknown[] }).fileMenuCalls);
    const readClipboard = () => app?.evaluate(({ clipboard }) => clipboard.readText());
    const absoluteFolder = await realpath(folder);
    const absoluteFile = await realpath(file);
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill(`检查 [订单](<${file}>)`);
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    const answer = page.locator(".answer");
    const menu = page.getByRole("menu");
    for (const name of ["资料目录", "相对目录", "文件 URL 目录"])
      await answer.getByRole("button", { name, exact: true }).click();
    await expect
      .poll(calls)
      .toEqual(Array.from({ length: 3 }, () => ({ action: "open", path: absoluteFolder })));
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect(page.getByRole("alert")).toHaveCount(0);

    const folderLink = answer.getByRole("button", { name: "资料目录", exact: true });
    await folderLink.click({ button: "right" });
    await expect(menu.getByRole("menuitem")).toHaveText(["打开", "Finder", "复制绝对路径", "复制相对路径"]);
    await menu.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect.poll(calls).toHaveLength(4);
    expect((await calls())?.at(-1)).toEqual({ action: "open", path: absoluteFolder });
    await folderLink.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "复制相对路径", exact: true }).click();
    await expect.poll(readClipboard).toBe("资料 目录");
    await expect(page.locator(".right-pane")).toBeHidden();

    const fileLink = answer.getByRole("button", { name: "文件", exact: true });
    await fileLink.click({ button: "right" });
    await expect(menu.getByRole("menuitem")).toHaveText(["打开", "Finder", "复制绝对路径", "复制相对路径"]);
    await expect(menu.getByRole("separator")).toHaveCount(2);
    await expect(menu).toHaveCSS("width", "208px");
    const finderIcon = menu.getByRole("menuitem", { name: "Finder", exact: true }).locator("img");
    await expect
      .poll(() => finderIcon.evaluate((img: HTMLImageElement) => img.naturalWidth))
      .toBeGreaterThan(0);
    await page.screenshot({ path: "test-results/conversation-file-menu-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "test-results/conversation-file-menu-dark.png" });
    await menu.getByRole("menuitem", { name: "打开", exact: true }).click();
    await expect(page.getByRole("tab", { name: "订单 %20 #1.json", exact: true })).toBeVisible();
    await expect(page.locator(".file-text-preview")).toContainText("订单文件");
    await expect(page.locator(".file-text-preview")).toHaveAttribute("data-line", "1");
    await fileLink.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect.poll(calls).toHaveLength(5);
    expect((await calls())?.at(-1)).toEqual({ action: "reveal", path: absoluteFile });
    await fileLink.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "复制绝对路径", exact: true }).click();
    await expect.poll(readClipboard).toBe(absoluteFile);
    await fileLink.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "复制相对路径", exact: true }).click();
    await expect.poll(readClipboard).toBe("资料 目录/订单 %20 #1.json");

    const userFile = page.locator(".user-message-text").getByRole("button", { name: "订单", exact: true });
    await userFile.click({ button: "right" });
    await expect(menu.getByRole("menuitem")).toHaveCount(4);
    await menu.getByRole("menuitem", { name: "复制绝对路径", exact: true }).click();
    await expect.poll(readClipboard).toBe(absoluteFile);
    await rm(file);
    await fileLink.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("文件不存在");
    expect(await calls()).toHaveLength(5);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

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
