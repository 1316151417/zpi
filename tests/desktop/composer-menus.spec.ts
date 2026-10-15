import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";
import { done, fakeServer } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("environment shortcut navigates the worktree switch and branch submenu without changing the draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-environment-shortcut-"));
  const project = join(dir, "project");
  await mkdir(project);
  const exec = promisify(execFile);
  const git = (...args: string[]) => exec("git", ["-C", project, ...args]);
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.test");
  await git("config", "user.name", "Test");
  await writeFile(join(project, "file.txt"), "fixture");
  await git("add", ".");
  await git("commit", "-m", "Initial");
  await git("branch", "feature/topic");
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    await expect(page.getByRole("button", { name: "配置本地环境", exact: true })).toBeVisible();
    await editor.fill("preserved draft");
    await editor.press(`${primary}+j`);
    const toggle = page.getByRole("menuitemcheckbox", { name: "新工作树", exact: true });
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(toggle).not.toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("ArrowDown");
    const branchTrigger = page.getByRole("menuitem", { name: "起始分支 main", exact: true });
    await expect(branchTrigger).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(branchTrigger).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const branches = page.locator(".worktree-branch-menu [role=menuitem]");
    await expect(branches.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(branches.nth(1)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(branches.first()).toBeFocused();
    const search = page.getByRole("textbox", { name: "搜索起始分支", exact: true });
    await search.fill("feature");
    await search.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "feature/topic", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".worktree-branch-menu")).toHaveCount(0);
    await expect(branchTrigger).toBeFocused();
    await page.keyboard.press("ArrowRight");
    const selected = await branches.first().innerText();
    await page.keyboard.press("Enter");
    await expect(page.locator(".worktree-branch-menu")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: `起始分支 ${selected}`, exact: true })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(toggle).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("preserved draft");
    expect(server.requests).toHaveLength(0);
    const treeList = (await git("worktree", "list", "--porcelain")).stdout;
    expect(treeList.match(/^worktree /gm)).toHaveLength(1);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("model shortcut opens only the focused auxiliary composer menu and restores its draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-model-menu-"));
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const main = page.locator("main");
    const mainEditor = main.getByLabel("消息", { exact: true });
    await mainEditor.fill("initial");
    await mainEditor.press("Enter");
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await mainEditor.fill("main draft");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    // The modal menu temporarily hides its owning pane from the accessibility tree.
    const side = page.locator(".side-chat-pane");
    await expect(side).toBeVisible();
    const editor = side.getByLabel("消息", { exact: true });
    await editor.fill("side draft");
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    await editor.press(`${primary}+l`);
    await expect(side.getByLabel("模型选择", { exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(main.getByLabel("模型选择", { exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("menuitem", { name: "fake", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("side draft");
    await expect(mainEditor).toHaveText("main draft");
    expect(server.requests).toHaveLength(1);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
