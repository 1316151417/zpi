import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

const exec = promisify(execFile);
test("file launcher, preview/navigation layout, search, Git filtering, refresh and task isolation match ZCode", async () => {
  test.setTimeout(90000);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-file-manager-")));
  const project = join(dir, "project");
  await mkdir(join(project, "src", "features", "auth"), { recursive: true });
  await mkdir(join(project, "other"));
  await writeFile(join(project, "README.md"), "# Preview sentinel\n");
  await writeFile(join(project, "src", "features", "auth", "index.ts"), "export const auth = true;\n");
  await writeFile(join(project, ".env"), "HIDDEN=1");
  await exec("git", ["init", "-q"], { cwd: project });
  await exec("git", ["add", "."], { cwd: project });
  await exec("git", ["-c", "user.email=test@example.test", "-c", "user.name=Test", "commit", "-qm", "seed"], {
    cwd: project,
  });
  await writeFile(join(project, "README.md"), "# Preview sentinel changed\n");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await page.getByLabel("添加项目", { exact: true }).click();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    const pane = page.locator(".right-pane");
    const launcher = pane.locator(".pane-empty-launcher");
    await expect(launcher.locator(".pane-launcher-label")).toHaveText(["文件", "浏览器", "终端", "审查"]);
    await expect(pane.getByRole("tab", { name: "新标签页", exact: true })).toBeVisible();
    await launcher.getByRole("button", { name: "文件", exact: true }).click();
    const manager = pane.locator(".file-manager").first();
    const tree = manager.getByRole("tree");
    const row = (name: string) => tree.getByRole("treeitem").filter({ hasText: name });
    await expect(manager).toBeVisible();
    await expect(pane.getByRole("tab", { name: "新标签页", exact: true })).toHaveCount(0);
    await expect(row(".env")).toBeVisible();
    await expect(manager.locator(".file-manager-empty")).toHaveText("从目录中选择一个文件");
    await row("README.md").click();
    await expect(pane.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
    await expect(manager.locator(".file-markdown-preview")).toContainText("Preview sentinel changed");
    await expect(manager.locator(".file-manager-toolbar .preview-header")).toHaveCount(1);
    await expect(manager.locator(".file-pane > .preview-header")).toHaveCount(0);
    await row("src").click();
    await expect(row("src/features/auth")).toBeVisible();
    await expect(row("index.ts")).toBeVisible();
    const search = manager.getByRole("textbox", { name: "搜索文件", exact: true });
    await search.fill("authindex");
    await expect(row("src/features/auth/index.ts")).toBeVisible();
    await search.fill("features");
    await row("src/features").first().click();
    await expect(search).toHaveValue("");
    await expect(row("index.ts")).toBeVisible();
    await manager.getByLabel("仅显示变更文件", { exact: true }).click();
    await expect(row("README.md")).toBeVisible();
    await expect(row(".env")).toHaveCount(0);
    await manager.getByLabel("显示全部文件", { exact: true }).click();
    await rename(
      join(project, "src", "features", "auth", "index.ts"),
      join(project, "src", "features", "auth", "renamed.ts"),
    );
    await expect(row("renamed.ts")).toBeVisible();
    await manager.getByLabel("刷新文件树", { exact: true }).click();
    await expect(row("renamed.ts")).toBeVisible();
    await expect(row("index.ts")).toHaveAttribute("data-git-status", "deleted");
    await row("index.ts").click();
    await expect(manager.locator(".file-markdown-preview")).toBeVisible();
    await row("renamed.ts").click({ button: "right" });
    await page.getByRole("menuitem", { name: "添加到聊天", exact: true }).click();
    const composer = page.locator("main").getByLabel("消息", { exact: true });
    await expect(composer).toContainText("renamed.ts");
    await row("README.md").evaluate((element) => {
      const transfer = new DataTransfer();
      element.dispatchEvent(new DragEvent("dragstart", { bubbles: true, dataTransfer: transfer }));
      document
        .querySelector("main .composer")
        ?.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer }));
      element.dispatchEvent(new DragEvent("dragend", { bubbles: true, dataTransfer: transfer }));
    });
    await expect(composer).toContainText("README.md");
    expect(server.requests).toHaveLength(0);
    await manager.getByLabel("收起文件导航", { exact: true }).click();
    await expect(manager.locator(".file-manager-directory")).toBeHidden();
    await page.getByLabel("新增侧栏标签", { exact: true }).click();
    await pane.locator('.pane-empty-launcher:visible [data-side-pane-open-tab-item="files"]').click();
    const second = pane.locator(".file-manager:visible");
    await expect(second.locator(".file-manager-directory")).toBeHidden();
    await second.getByLabel("显示文件导航", { exact: true }).click();
    await expect(second.locator(".file-manager-directory")).toBeVisible();
    await page.getByLabel("关闭标签 文件", { exact: true }).last().click();
    await expect(manager.locator(".file-manager-directory")).toBeVisible();
    const directoryBefore = await manager.locator(".file-manager-directory").boundingBox();
    await manager.getByLabel("调整文件目录宽度", { exact: true }).press("ArrowLeft");
    await expect
      .poll(async () => (await manager.locator(".file-manager-directory").boundingBox())?.width ?? 0)
      .toBeGreaterThan(directoryBefore?.width ?? 0);
    await page.screenshot({ path: "test-results/file-manager-wide-light.png" });
    await pane.screenshot({ path: "test-results/file-manager-panel-light.png" });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({ path: "test-results/file-manager-wide-dark.png" });
    await pane.screenshot({ path: "test-results/file-manager-panel-dark.png" });
    await pane.getByLabel("右侧栏宽度", { exact: true }).press("ArrowRight");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 760));
    await expect(manager).toHaveAttribute("data-navigation-only", "true");
    await row("README.md").click();
    await expect(manager.locator(".file-manager-directory")).toBeHidden();
    await expect(manager.locator(".file-markdown-preview")).toBeVisible();
    await page.screenshot({ path: "test-results/file-manager-narrow-dark.png" });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await expect(manager.locator(".file-manager-directory")).toBeVisible();
    const taskId = await page.evaluate(async () => {
      const result = await window.zpi.listRecentSessions();
      if (!result.ok) throw new Error(result.error.message);
      const task = result.value.find((task) => task.draft && task.projectId);
      if (!task) throw new Error("Missing project draft");
      const configured = await window.zpi.setNewWorktree(task.id, true);
      if (!configured.ok) throw new Error(configured.error.message);
      return task.id;
    });
    await composer.fill("创建工作树");
    await composer.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const workspace = await page.evaluate((id) => window.zpi.getWorkspaceInfo(id), taskId);
    expect(workspace).not.toMatchObject({ ok: true, value: { cwd: project } });
    await writeFile(join(project, "original-root.txt"), "frozen target");
    await manager.getByLabel("刷新文件树", { exact: true }).click();
    await expect(row("original-root.txt")).toBeVisible();
    await expect(manager.locator(".preview-breadcrumb")).toContainText("project");
    await manager.getByLabel("收起文件导航", { exact: true }).click();
    await page.reload();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator('[data-side-pane-open-tab-item="files"]').click();
    await expect(page.locator(".file-manager-directory")).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("unassigned task workspaces survive navigation and restart and remain separate between new tasks", async () => {
  test.setTimeout(60000);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-draft-workspaces-")));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    const first = await page.evaluate(async () => {
      const result = await window.zpi.listRecentSessions();
      if (!result.ok) throw new Error(result.error.message);
      return result.value[0];
    });
    expect(first.cwd).toBe(join(dir, "workspace", `draft-${first.id}`));
    if (!first.cwd) throw new Error("Missing draft cwd");
    await writeFile(join(first.cwd, "keep.txt"), "keep draft data");
    await page.getByLabel("消息", { exact: true }).fill("第一项任务");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect
      .poll(async () =>
        page.evaluate(async () => {
          const result = await window.zpi.listRecentSessions();
          return result.ok ? result.value.length : 0;
        }),
      )
      .toBe(2);
    const second = await page.evaluate(async () => {
      const result = await window.zpi.listRecentSessions();
      if (!result.ok) throw new Error(result.error.message);
      const draft = result.value.find((task) => task.draft);
      if (!draft) throw new Error("Missing draft");
      return draft;
    });
    expect(second.cwd).toBe(join(dir, "workspace", `draft-${second.id}`));
    expect(second.cwd).not.toBe(first.cwd);
    await page.getByLabel("新建任务", { exact: true }).first().click();
    const reused = await page.evaluate(async () => {
      const result = await window.zpi.listRecentSessions();
      return result.ok ? result.value.filter((task) => task.draft).map((task) => task.id) : [];
    });
    expect(reused).toEqual([second.id]);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    const restored = await page.evaluate(async (id) => window.zpi.getWorkspaceInfo(id), first.id);
    expect(restored).toMatchObject({ ok: true, value: { cwd: first.cwd } });
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator('[data-side-pane-open-tab-item="files"]').click();
    await expect(page.locator(".file-tree-toolbar h3")).toHaveText(`draft-${second.id}`);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
