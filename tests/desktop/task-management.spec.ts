import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import sharp from "sharp";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { expectNoCornerTooltipDuring } from "../helpers/tooltip.ts";

const editor = (page: Page) => page.getByLabel("消息", { exact: true });
const openMenu = async (page: Page) => {
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.getByLabel("任务菜单", { exact: true }).click();
  await expect(page.getByRole("menu")).toBeVisible();
};
const openArchives = async (page: Page) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "已归档任务", exact: true }).click();
};

test("running task menu, directory actions, Escape dismissal/IME priority and archive queue closure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-actions-"));
  const project = join(dir, "中文 项目");
  await mkdir(project);
  await writeFile(join(project, "file.txt"), "reference");
  const image = join(dir, "image.png");
  await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
    .png()
    .toFile(image);
  const server = await fakeServer((_, res) => send(res, chunk({ content: "live response" })));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url, images: [image] });
    const page = await app.firstWindow();
    await expect(editor(page)).toBeFocused();
    await page.evaluate(async () => {
      const result = await window.zpi.getSettings();
      if (!result.ok) throw new Error(result.error.message);
      const provider = result.value.providers[0];
      const credentials = await window.zpi.getProviderCredentials(provider.id);
      if (!credentials.ok) throw new Error(credentials.error.message);
      const saved = await window.zpi.saveProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKey: credentials.value.apiKey,
        models: provider.models.map((m) => ({ ...m, input: ["text", "image"] })),
      });
      if (!saved.ok) throw new Error(saved.error.message);
    });
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await expect(editor(page)).toBeFocused();
    await editor(page).fill("运行任务");
    await editor(page).press("Enter");
    await expect(page.locator(".answer")).toHaveText("live response");
    const run = page.getByTestId("run");
    const row = page.locator('.projects [data-testid="session-row"]').first();
    await expect(row.getByLabel("归档任务 运行任务", { exact: true })).toBeDisabled();
    const archiveButton = row.getByLabel("归档任务 运行任务", { exact: true });
    await editor(page).focus();
    await editor(page).hover();
    await expect(archiveButton).toBeHidden();
    await row.hover();
    const disabledAppearance = await archiveButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
    });
    await archiveButton.hover();
    await expect(page.getByRole("tooltip")).toContainText("请先停止运行");
    expect(
      await archiveButton.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
      }),
    ).toEqual(disabledAppearance);
    await expect(archiveButton).toHaveCSS("opacity", "0.45");
    const rowBounds = await row.boundingBox();
    if (!rowBounds) throw new Error("missing task row bounds");
    for (const point of [
      { x: Math.max(1, rowBounds.x - 3), y: rowBounds.y + rowBounds.height / 2 },
      { x: rowBounds.x + rowBounds.width + 3, y: rowBounds.y + rowBounds.height / 2 },
      { x: rowBounds.x + rowBounds.width / 2, y: rowBounds.y - 3 },
      { x: rowBounds.x + rowBounds.width / 2, y: rowBounds.y + rowBounds.height + 3 },
    ]) {
      await row.hover();
      await archiveButton.hover();
      await expect(page.getByRole("tooltip")).toContainText("请先停止运行");
      await expectNoCornerTooltipDuring(page, () => page.mouse.move(point.x, point.y));
      await expect(archiveButton).toBeHidden();
    }
    await editor(page).hover();
    await expect(archiveButton).toBeHidden();
    await row.locator(".session-name").focus();
    await expect(archiveButton).toHaveCSS("opacity", "0.45");
    await expect(archiveButton).toBeDisabled();
    await editor(page).focus();
    await expect(archiveButton).toBeHidden();
    await page.getByLabel("任务菜单", { exact: true }).hover();
    const iconOffset = await page.getByLabel("任务菜单", { exact: true }).evaluate((el) => {
      const button = el.getBoundingClientRect();
      const icon = el.querySelector("svg")?.getBoundingClientRect();
      if (!icon) throw new Error("missing menu icon");
      return {
        x: Math.abs(icon.x + icon.width / 2 - button.x - button.width / 2),
        y: Math.abs(icon.y + icon.height / 2 - button.y - button.height / 2),
      };
    });
    expect(iconOffset.x).toBeLessThan(1);
    expect(iconOffset.y).toBeLessThan(1);
    await openMenu(page);
    await expect(page.getByRole("menuitem")).toHaveCount(6);
    await expect(page.getByRole("separator")).toHaveCSS("height", "1px");
    await expect(page.getByRole("menuitem", { name: /^归档任务/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByLabel("任务菜单", { exact: true })).toHaveCSS("-webkit-app-region", "no-drag");
    await page.screenshot({ path: "test-results/task-menu.png" });
    await page.keyboard.press("Escape");
    await expect(run).toHaveAttribute("data-status", "running");
    await openMenu(page);
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(page.locator(".pinned-tasks .session-name")).toHaveText("运行任务");
    await openMenu(page);
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(run).toHaveAttribute("data-status", "running");
    await openMenu(page);
    await page.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    await page.getByLabel("名称", { exact: true }).fill("手动名称");
    await page
      .getByLabel("名称", { exact: true })
      .dispatchEvent("keydown", { key: "Enter", isComposing: true });
    await expect(page.getByRole("dialog", { name: "重命名任务", exact: true })).toBeVisible();
    await page.getByLabel("名称", { exact: true }).press("Enter");
    await expect(page.locator(".topbar-title")).toHaveText("手动名称");
    await expect(run).toHaveAttribute("data-status", "running");
    await openMenu(page);
    await page.getByRole("menuitem", { name: "复制路径", exact: true }).click();
    await expect
      .poll(() => app?.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(await realpath(project));
    const sessionId = await page
      .locator('.pinned-tasks [data-testid="session-row"]')
      .first()
      .getAttribute("data-session-id");
    const copiedSessionPath = async () => app?.evaluate(({ clipboard }) => clipboard.readText());
    await openMenu(page);
    await expect(page.getByRole("menuitem")).toHaveText([
      "取消置顶",
      "重命名任务",
      "归档任务请先停止运行",
      "Finder",
      "复制路径",
      "复制会话路径",
    ]);
    await page.getByRole("menuitem", { name: "复制会话路径", exact: true }).click();
    await expect.poll(copiedSessionPath).toMatch(new RegExp(`${sessionId}\\.jsonl$`));
    const sessionPath = await copiedSessionPath();
    expect(sessionPath).toContain(join(dir, "agent", "sessions"));
    expect(await readFile(sessionPath as string, "utf8")).toContain("运行任务");
    const sidebarRow = page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
    await sidebarRow.hover();
    await expect(sidebarRow.locator(".task-more")).toHaveCount(0);
    await app.evaluate(({ shell }) => {
      shell.openPath = async (path) => {
        (globalThis as typeof globalThis & { openedDirectory: string }).openedDirectory = path;
        return "";
      };
    });
    await openMenu(page);
    await page.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect
      .poll(() =>
        app?.evaluate(() => (globalThis as typeof globalThis & { openedDirectory?: string }).openedDirectory),
      )
      .toBe(await realpath(project));
    await editor(page).fill("/");
    await expect(page.getByRole("listbox", { name: "指令", exact: true })).toBeVisible();
    await editor(page).press("Escape");
    await expect(page.getByRole("listbox")).toHaveCount(0);
    await expect(run).toHaveAttribute("data-status", "running");
    await editor(page).fill("@file");
    await expect(page.getByRole("listbox", { name: "引用文件", exact: true })).toBeVisible();
    await editor(page).press("Escape");
    await expect(run).toHaveAttribute("data-status", "running");
    await editor(page).fill("");
    await editor(page).dispatchEvent("compositionstart", { data: "zhong" });
    await editor(page).press("Escape");
    await expect(run).toHaveAttribute("data-status", "running");
    await editor(page).dispatchEvent("compositionend", { data: "" });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(page.getByLabel("关闭设置", { exact: true })).toBeFocused();
    await page.getByLabel("关闭设置", { exact: true }).hover();
    // Escape dismisses any outstanding control hint before the settings surface.
    if (await page.getByRole("tooltip").count()) await page.keyboard.press("Escape");
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0);
    await expect(run).toHaveAttribute("data-status", "running");
    await page.getByLabel("添加上下文", { exact: true }).click();
    await page.getByRole("option", { name: "附件", exact: true }).click();
    await page.getByRole("button", { name: "预览 image.png", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "图片预览", exact: true })).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(run).toHaveAttribute("data-status", "running");
    await editor(page).fill("queued input");
    await editor(page).press("Enter");
    await expect(page.locator(".conversation-queue")).toContainText("queued input");
    await page.keyboard.press("Escape");
    await expect(run).toHaveAttribute("data-status", "aborted");
    await openMenu(page);
    await page.getByRole("menuitem", { name: "归档任务", exact: true }).click();
    await expect(page.locator(".topbar-title")).not.toHaveText("手动名称");
    await expect(page.locator(".session-name").filter({ hasText: "手动名称" })).toHaveCount(0);
    await openArchives(page);
    const archived = page.locator(".archived-row");
    await expect(archived).toContainText("手动名称");
    await expect(archived).toContainText("中文 项目");
    await page.screenshot({ path: "test-results/archived-tasks.png" });
    await archived.getByRole("button", { name: "恢复", exact: true }).click();
    await expect(archived).toHaveCount(0);
    await page.getByLabel("关闭设置").click();
    await page.locator(".projects .session-name").filter({ hasText: "手动名称" }).click();
    await expect(editor(page)).toBeFocused();
    await expect(page.locator(".conversation-queue")).toHaveCount(0);
    expect(server.requests).toHaveLength(1);
    await page.keyboard.press("Escape");
    await expect(run).toHaveAttribute("data-status", "aborted");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("archived and damaged groups, counted delete confirmation and batch deletion continues after failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-archived-settings-"));
  await mkdir(join(dir, "agent", "sessions", "_unassigned"), { recursive: true });
  await writeFile(join(dir, "agent", "sessions", "_unassigned", "broken-task.jsonl"), "bad header\n");
  const server = await fakeServer((_, res) => done(res));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(editor(page)).toBeVisible();
    await page.evaluate(async () => {
      for (const title of ["archived one", "archived two"]) {
        const created = await window.zpi.createSession(null);
        if (!created.ok) throw new Error(created.error.message);
        await window.zpi.renameSession(created.value.id, title);
        await window.zpi.archiveSession(created.value.id);
      }
    });
    await openArchives(page);
    const damaged = page.getByRole("region", { name: "无法读取的任务", exact: true });
    await expect(damaged.locator(".archived-row")).toHaveCount(1);
    await expect(damaged.getByRole("button", { name: "恢复", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "全部删除", exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("永久删除 3 个任务");
    expect(
      await page.getByRole("dialog").evaluate((dialog) => {
        const settings = document.querySelector(".settings-screen");
        const backdrop = document.querySelector(".archived-delete-backdrop");
        if (!settings || !backdrop) throw new Error("missing confirmation layers");
        const layer = (el: Element) => Number(getComputedStyle(el).zIndex);
        return layer(dialog) > layer(backdrop) && layer(backdrop) > layer(settings);
      }),
    ).toBe(true);
    await page.screenshot({ path: "test-results/archived-delete-confirmation.png" });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    const failedId = await page.evaluate(async () => {
      const records = await window.zpi.listArchivedSessions();
      if (!records.ok) throw new Error(records.error.message);
      return records.value.find((r) => r.title === "archived two")?.id;
    });
    if (!failedId) throw new Error("missing archived task");
    const snapshot = join(dir, "agent", "tool-output", failedId);
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "before.txt"), "snapshot");
    await chmod(snapshot, 0o500);
    await page.getByRole("button", { name: "全部删除", exact: true }).click();
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator(".archived-row")).toHaveCount(1);
    await expect(page.getByRole("alert")).toContainText("archived two");
    await expect(page.locator(".archived-row")).toContainText("archived two");
    await chmod(snapshot, 0o700);
    await page.reload();
    await openArchives(page);
    await page.getByLabel("删除任务 archived two", { exact: true }).click();
    await expect(page.getByRole("dialog")).toContainText("永久删除 1 个任务");
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator(".archived-row")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("every new-task entry focuses the composer when creating or reusing a draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-new-task-focus-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const selected = () => page.evaluate(() => localStorage.getItem("zpi.selectedSession"));
    await expect(editor(page)).toBeFocused();
    const unassigned = await selected();
    const globalNew = page.locator(".sidebar-global").getByLabel("新建任务", { exact: true });
    const mac = process.platform === "darwin";
    await expect(globalNew.locator(".sidebar-action-shortcut")).toHaveText(mac ? "⌘ N" : "Ctrl+N");
    await globalNew.click();
    await expect(editor(page)).toBeFocused();
    expect(await selected()).toBe(unassigned);
    await globalNew.focus();
    await page.keyboard.press(mac ? "Meta+n" : "Control+n");
    await expect(editor(page)).toBeFocused();
    expect(await selected()).toBe(unassigned);
    await page.keyboard.type("前尾");
    await page.keyboard.press("ArrowLeft");
    await globalNew.click();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("X");
    await expect(editor(page)).toHaveText("前X尾");
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("project");
    await expect(editor(page)).toBeFocused();
    const projectDraft = await selected();
    expect(projectDraft).not.toBe(unassigned);
    await page.locator(".project-title").hover();
    await page.getByLabel("新建任务 project", { exact: true }).click();
    await expect(editor(page)).toBeFocused();
    expect(await selected()).toBe(projectDraft);
    const taskHeader = page.locator(".sidebar-heading").filter({ hasText: /^任务$/ });
    await taskHeader.hover();
    await taskHeader.getByLabel("新建任务", { exact: true }).click();
    await expect(editor(page)).toBeFocused();
    expect(await selected()).toBe(unassigned);
    await taskHeader.hover();
    await taskHeader.getByLabel("新建任务", { exact: true }).click();
    await expect(editor(page)).toBeFocused();
    await page.getByLabel("收起侧边栏", { exact: true }).click();
    await page.locator('.window-chrome-button[aria-label="新建任务"]').click();
    await expect(editor(page)).toBeFocused();
    expect(await selected()).toBe(unassigned);
    await page.getByLabel("展开侧边栏", { exact: true }).click();
    await page.getByLabel("选择项目", { exact: true }).click();
    await page.getByRole("menuitem", { name: "project", exact: true }).click();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("project");
    await expect(editor(page)).toBeFocused();
    await page.locator(".draft-project-chip").hover();
    const detach = page.getByLabel("取消选择当前项目", { exact: true });
    await expect(detach).toBeEnabled();
    await expect(detach).toHaveCSS("pointer-events", "auto");
    await detach.click({ timeout: 3000 });
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("选择项目");
    await expect(editor(page)).toBeFocused();
    expect(await selected()).toBe(unassigned);
    await page.keyboard.type("Y");
    await expect(editor(page)).toHaveText("前XY尾");
    expect(server.requests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("composer focus restores per-task caret on switch/restart and terminal tabs receive focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-input-focus-"));
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "done" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("task A");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await editor(page).fill("abcdef草稿");
    await editor(page).evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Node, 2);
      range.setEnd(el.firstChild as Node, 5);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const id = localStorage.getItem("zpi.selectedSession");
          if (!id) return;
          const draft = await window.zpi.getDraft(id);
          return draft.ok ? draft.value.selection : undefined;
        }),
      )
      .toEqual([2, 5]);
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(editor(page)).toBeFocused();
    await page.keyboard.type("task B");
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await editor(page).fill("B draft");
    await page.locator(".recent-sessions .session-name").filter({ hasText: "task A" }).click();
    await expect(editor(page)).toBeFocused();
    await expect(editor(page)).toHaveText("abcdef草稿");
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("cde");
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(editor(page)).toBeFocused();
    await expect.poll(() => page.evaluate(() => window.getSelection()?.toString())).toBe("cde");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "终端", exact: true }).click();
    const terminal = page.locator(".xterm-helper-textarea");
    await expect(terminal).toBeFocused();
    await page.keyboard.type("printf 'FOCUS_OK\\n'");
    await page.keyboard.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("FOCUS_OK");
    await page.getByRole("button", { name: "新增侧栏标签", exact: true }).click();
    await page.getByRole("menuitem", { name: "变更", exact: true }).click();
    await page.getByRole("tab", { name: "zsh", exact: true }).click();
    await expect(terminal).toBeFocused();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
