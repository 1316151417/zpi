import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
    await pane.locator(".review-change-list").evaluate((element) => (element.scrollTop = 150));
    expect(await pane.locator(".review-change-list").evaluate((element) => element.scrollTop)).toBe(150);
    await page.getByRole("button", { name: "进入完整视图", exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-floating/);
    await expect(page.locator(".sidebar")).toBeHidden();
    expect((await page.locator(".right-pane").boundingBox())?.x).toBe(4);
    expect((await page.locator(".right-pane").boundingBox())?.width).toBeGreaterThan(
      (initial?.width ?? 0) * 1.8,
    );
    await expect(composer).toHaveText("retain this draft");
    await expect(pane.locator(".review-file-row")).toHaveAttribute("aria-expanded", "true");
    await expect(pane.locator("diffs-container")).toContainText("value0 = 0");
    await expect
      .poll(() => pane.locator(".review-change-list").evaluate((element) => element.scrollTop))
      .toBe(150);
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
    const handle = await grip.boundingBox();
    if (!handle) throw new Error("Floating editor handle is missing");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(100, 100, { steps: 5 });
    await page.mouse.up();
    await expect(page.locator(".pane-full-view-controls")).toHaveAttribute("data-anchor", "top-left");
    await expect(composer).toHaveText("retain this draft");
    await page.getByRole("tab", { name: "review shell", exact: true }).click();
    await expect(page.locator(".shell")).toHaveClass(/pane-full-conversation/);
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
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
