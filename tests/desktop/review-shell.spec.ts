import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { runGit } from "../../packages/desktop/src/main/workspace-files.ts";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("review tabs support overview, closure restoration and complete-view conversation without losing drafts or diff state", async ({
  desktopIsolation,
}, testInfo) => {
  void desktopIsolation;
  const dir = await mkdtemp(join(tmpdir(), "zpi-review-shell-")),
    project = join(dir, "project");
  await mkdir(project);
  await runGit(project, ["init", "-b", "main"]);
  await runGit(project, ["config", "user.name", "Review Test"]);
  await runGit(project, ["config", "user.email", "review@example.invalid"]);
  const file = join(project, "main.ts");
  const original = Array.from({ length: 120 }, (_, index) => `export const value${index} = ${index};`).join(
    "\n",
  );
  await writeFile(file, original);
  await runGit(project, ["add", "."]);
  await runGit(project, ["commit", "-m", "Initial"]);
  await writeFile(file, original.replace("value19 = 19", "value19 = 190"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "Completed review shell reply." }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1512, 893));
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const composer = page.getByLabel("消息", { exact: true });
    await composer.fill("review shell");
    await composer.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByRole("button", { name: "展开右侧栏", exact: true }).click();
    await page.locator('[data-side-pane-open-tab-item="review"]:visible').click();
    const pane = page.locator(".review-pane:visible");
    await pane.getByRole("button", { name: /main.ts/ }).click();
    await pane.locator("[data-separator-first] [data-expand-button]").first().click();
    await expect(pane.locator("diffs-container")).toContainText("value0 = 0");
    await pane.locator("[data-separator-last] [data-expand-button]").first().click();
    await expect(pane.locator("diffs-container")).toContainText("value119 = 119");
    await composer.fill("retain this draft");
    const initial = await page.locator(".right-pane").boundingBox();
    const sidebar = await page.locator(".sidebar").boundingBox();
    await pane.locator(".review-change-list").evaluate((element) => (element.scrollTop = 150));
    expect(await pane.locator(".review-change-list").evaluate((element) => element.scrollTop)).toBe(150);
    await page.getByRole("button", { name: "进入完整视图", exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-floating/);
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(await page.locator(".sidebar").boundingBox()).toEqual(sidebar);
    expect((await page.locator(".right-pane").boundingBox())?.x).toBe((sidebar?.width ?? 0) + 4);
    expect((await page.locator(".right-pane").boundingBox())?.width).toBeGreaterThan(initial?.width ?? 0);
    const input = page.locator(".main .composer");
    await expect(input).toHaveCSS("height", "46px");
    await expect(input.getByRole("button")).toHaveCount(2);
    await expect(input.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    const plus = input.getByRole("button", { name: "添加上下文", exact: true });
    const plusBox = await plus.boundingBox();
    const editorBox = await composer.boundingBox();
    const sendBox = await input.getByRole("button", { name: "发送", exact: true }).boundingBox();
    expect(plusBox?.y).toBe(editorBox?.y);
    expect(sendBox?.y).toBe(editorBox?.y);
    expect(editorBox?.x).toBe((plusBox?.x ?? 0) + 36);
    expect(sendBox?.x).toBe((editorBox?.x ?? 0) + (editorBox?.width ?? 0) + 8);
    await plus.click();
    const addPanel = page.getByRole("listbox", { name: "添加上下文", exact: true });
    await expect(addPanel).toBeVisible();
    await addPanel.press("Escape");
    await expect(composer).toHaveText("retain this draft");
    await expect(pane.locator(".review-file-row")).toHaveAttribute("aria-expanded", "true");
    await expect(pane.locator("diffs-container")).toContainText("value0 = 0");
    await expect
      .poll(() => pane.locator(".review-change-list").evaluate((element) => element.scrollTop))
      .toBe(150);
    await composer.focus();
    await expect(page.locator(".main")).toHaveCSS("height", "86px");
    await page.screenshot({ path: testInfo.outputPath("full-view-focused-light.png") });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(input).toHaveCSS("background-color", "rgb(43, 43, 43)");
    await page.screenshot({ path: testInfo.outputPath("full-view-focused-dark.png") });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(input).toHaveCSS("background-color", "rgb(255, 255, 255)");
    await composer.fill("first line\nsecond line\nthird line");
    await expect(input).toHaveCSS("height", "86px");
    await composer.fill("retain this draft");
    await pane.getByRole("combobox", { name: "审查来源", exact: true }).focus();
    await page.mouse.move(700, 100);
    await expect(page.locator(".main")).toHaveCSS("height", "46px");
    await page.screenshot({ path: testInfo.outputPath("full-view-idle.png") });
    await composer.hover();
    await expect(page.locator(".main")).toHaveCSS("height", "86px");
    await composer.focus();
    await page.getByRole("button", { name: "展开消息", exact: true }).click();
    await expect(page.locator(".main")).toHaveCSS("height", "640px");
    await page.getByRole("button", { name: "最小化编辑器", exact: true }).click();
    await expect(page.getByRole("button", { name: "展开编辑器", exact: true })).toBeVisible();
    await expect(composer).toBeHidden();
    await page.getByRole("button", { name: "展开编辑器", exact: true }).click();
    await expect(composer).toBeVisible();
    await expect(composer).toHaveText("retain this draft");
    const grip = page.getByRole("button", { name: "拖动以移动 · 点击查看选项", exact: true });
    await grip.click();
    await page.getByRole("menuitem", { name: "最小化编辑器", exact: true }).click();
    await page.getByRole("button", { name: "展开编辑器", exact: true }).click();
    await grip.hover();
    await expect(page.locator(".pane-full-view-controls")).toHaveCSS("height", "40px");
    const handle = await grip.boundingBox();
    if (!handle) throw new Error("Floating editor handle is missing");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(100, 100, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator(".pane-full-view-controls")).toHaveAttribute("data-anchor", "top-left");
    await expect(composer).toHaveText("retain this draft");
    const floatingLeft = () =>
      page.locator(".main").evaluate((element) => element.getBoundingClientRect().left);
    await expect.poll(floatingLeft).toBeCloseTo((sidebar?.width ?? 0) + 21, 1);
    await page.getByTestId("left-sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await expect.poll(floatingLeft).toBeCloseTo(21, 1);
    await page.getByTestId("left-sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect.poll(floatingLeft).toBeCloseTo((sidebar?.width ?? 0) + 21, 1);
    await page.getByRole("separator", { name: "侧边栏宽度", exact: true }).press("ArrowRight");
    await expect.poll(floatingLeft).toBeCloseTo((sidebar?.width ?? 0) + 37, 1);
    await page.getByRole("separator", { name: "侧边栏宽度", exact: true }).press("ArrowLeft");
    await expect.poll(floatingLeft).toBeCloseTo((sidebar?.width ?? 0) + 21, 1);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(800, 700));
    await expect
      .poll(async () => {
        const frame = await page.locator(".main").boundingBox();
        const slot = await page.locator(".right-pane-content").boundingBox();
        return frame && slot && frame.x >= slot.x && frame.x + frame.width <= slot.x + slot.width - 16;
      })
      .toBe(true);
    await expect(input).toHaveCSS("height", "46px");
    await page.screenshot({ path: testInfo.outputPath("full-view-narrow.png") });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1512, 893));
    await page.getByRole("tab", { name: "review shell", exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-conversation/);
    await expect(page.locator(".sidebar")).toBeVisible();
    await expect.poll(floatingLeft).toBeCloseTo((sidebar?.width ?? 0) + 5, 1);
    await page.getByTestId("left-sidebar-toggle").click();
    await expect.poll(floatingLeft).toBeCloseTo(5, 1);
    await expect(page.getByRole("tab", { name: "review shell", exact: true })).toBeVisible();
    await page.getByTestId("left-sidebar-toggle").click();
    await expect.poll(floatingLeft).toBeCloseTo((sidebar?.width ?? 0) + 5, 1);
    await expect(page.getByTestId("run")).toBeVisible();
    await expect(page.getByRole("tab", { name: "审查", exact: true })).toHaveAttribute(
      "aria-selected",
      "false",
    );
    await page.getByRole("tab", { name: "审查", exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-floating/);
    await expect(composer).toHaveText("retain this draft");
    await page.getByRole("button", { name: "退出完整视图", exact: true }).click();
    await expect(page.locator(".shell")).not.toHaveClass(/pane-full-view/);
    expect((await page.locator(".right-pane").boundingBox())?.width).toBe(initial?.width);
    await page.getByRole("button", { name: "新增侧栏标签", exact: true }).click();
    await page.locator('[data-side-pane-open-tab-item="files"]:visible').click();
    await page.getByRole("button", { name: "搜索标签页", exact: true }).click();
    await page.getByPlaceholder("搜索标签页...", { exact: true }).fill("审查");
    await page.getByRole("option", { name: /审查/ }).click();
    await page.getByRole("tab", { name: "审查", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "关闭其他标签", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "侧栏标签" }).getByRole("tab")).toHaveCount(1);
    await pane.getByRole("combobox", { name: "审查来源", exact: true }).click();
    await page.getByRole("option", { name: "已暂存", exact: true }).click();
    await page.getByRole("tab", { name: "审查", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "关闭标签", exact: true }).click();
    await page.getByRole("button", { name: "展开右侧栏", exact: true }).click();
    await page.getByRole("button", { name: "搜索标签页", exact: true }).click();
    await expect(page.getByText("最近关闭的标签页", { exact: true })).toBeVisible();
    await page.getByRole("option", { name: /审查/ }).click();
    await expect(pane.getByRole("combobox", { name: "审查来源", exact: true })).toHaveText("已暂存");
    await expect(page.locator(".pane-tab-overview")).toBeHidden();
    await composer.focus();
    await composer.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+f`);
    await expect(page.locator(".shell")).toHaveClass(/pane-full-view/);
    await composer.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+f`);
    await expect(page.locator(".shell")).not.toHaveClass(/pane-full-view/);
    await page.getByRole("button", { name: "进入完整视图", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.getByTestId("left-sidebar-toggle").click();
    await expect(page.locator(".sidebar")).toBeHidden();
    expect((await page.locator(".right-pane").boundingBox())?.x).toBe(4);
    await expect(page.getByTestId("model-performance")).toBeHidden();
    await composer.fill("another answer in full view");
    await composer.press("Enter");
    await expect(page.locator(".pane-floating-answer")).toContainText("Completed review shell reply.");
    await expect(page.locator(".pane-floating-answer")).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("review-full-view.png") });
    await page.getByRole("button", { name: "关闭回答预览", exact: true }).click();
    await expect(page.locator(".pane-floating-answer")).toBeHidden();
    await page.getByRole("button", { name: "退出完整视图", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await page.getByRole("button", { name: "进入完整视图", exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});

test("full view keeps an unsent draft compact and attachments above its inline input", async ({
  desktopIsolation,
}, testInfo) => {
  void desktopIsolation;
  const dir = await mkdtemp(join(tmpdir(), "zpi-full-view-draft-"));
  const project = join(dir, "project");
  await mkdir(project);
  const image = join(dir, "sample.png");
  await sharp({ create: { width: 16, height: 16, channels: 3, background: "blue" } })
    .png()
    .toFile(image);
  const server = await fakeServer((_, response) => done(response));
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, project, images: [image], url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).click();
    const editor = page.getByLabel("消息", { exact: true });
    const input = page.locator(".main .composer");
    await editor.fill("unsent draft");
    const originalEditor = await editor.elementHandle();
    await page.getByTestId("right-sidebar-toggle").click();
    await page.getByRole("button", { name: "进入完整视图", exact: true }).click();
    await expect(page.locator(".draft-composer-header")).toBeHidden();
    await expect(input).toHaveCSS("height", "46px");
    await input.getByRole("button", { name: "添加上下文", exact: true }).click();
    await page.getByRole("option", { name: "附件", exact: true }).click();
    const attachment = input.locator(".image-chip");
    await expect(attachment).toBeVisible();
    await expect(input).toHaveCSS("height", "102px");
    const attachmentBox = await attachment.boundingBox();
    const editorBox = await editor.boundingBox();
    expect((attachmentBox?.y ?? 0) + (attachmentBox?.height ?? 0)).toBeLessThan(editorBox?.y ?? 0);
    await page.screenshot({ path: testInfo.outputPath("full-view-draft-attachment.png") });
    await page.getByRole("button", { name: "最小化编辑器", exact: true }).click();
    await page.getByRole("button", { name: "展开编辑器", exact: true }).click();
    await expect(attachment).toBeVisible();
    await page.getByRole("button", { name: "移除 sample.png", exact: true }).click();
    await expect(input).toHaveCSS("height", "46px");
    await page.getByRole("button", { name: "退出完整视图", exact: true }).click();
    await expect(page.locator(".draft-composer-header")).toBeVisible();
    await expect(editor).toHaveText("unsent draft");
    expect(await editor.evaluate((element, original) => element === original, originalEditor)).toBe(true);
    expect(server.requests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
