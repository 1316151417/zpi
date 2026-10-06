import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

const editor = (page: Page) => page.getByLabel("消息", { exact: true });
const openMenu = (page: Page) => page.getByLabel("任务菜单", { exact: true }).click();
const openArchives = async (page: Page) => {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "已归档任务", exact: true }).click();
};

test("running task menu, directory actions, Escape dismissal/IME priority and archive queue closure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-task-actions-"));
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
      const result = await window.ZPI.getSettings();
      if (!result.ok) throw new Error(result.error.message);
      const provider = result.value.providers[0];
      const credentials = await window.ZPI.getProviderCredentials(provider.id);
      if (!credentials.ok) throw new Error(credentials.error.message);
      const saved = await window.ZPI.saveProvider({
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
    await expect(row.getByLabel("归档任务 运行任务", { exact: true })).toHaveAttribute(
      "title",
      "请先停止运行",
    );
    const archiveButton = row.getByLabel("归档任务 运行任务", { exact: true });
    await row.hover();
    const disabledAppearance = await archiveButton.evaluate((el) => {
      const style = getComputedStyle(el);
      return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
    });
    await archiveButton.hover();
    expect(
      await archiveButton.evaluate((el) => {
        const style = getComputedStyle(el);
        return { color: style.color, background: style.backgroundColor, opacity: style.opacity };
      }),
    ).toEqual(disabledAppearance);
    await expect(archiveButton).toHaveCSS("opacity", "0.45");
    await page.getByLabel("任务菜单").hover();
    const iconOffset = await page.getByLabel("任务菜单").evaluate((el) => {
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
    await expect(page.getByRole("menuitem")).toHaveCount(5);
    await expect(page.getByRole("menuitem", { name: /^归档任务/ })).toHaveAttribute("aria-disabled", "true");
    await expect(page.getByLabel("任务菜单")).toHaveCSS("-webkit-app-region", "no-drag");
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
    await page.keyboard.press("Escape");
    await expect(page.getByRole("region", { name: "设置", exact: true })).toHaveCount(0);
    await expect(run).toHaveAttribute("data-status", "running");
    await page.getByLabel("添加附件", { exact: true }).click();
    await page.getByRole("menuitem", { name: "添加图片…", exact: true }).click();
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
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("archived and damaged groups, counted delete confirmation and batch deletion continues after failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-archived-settings-"));
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
        const created = await window.ZPI.createSession(null);
        if (!created.ok) throw new Error(created.error.message);
        await window.ZPI.renameSession(created.value.id, title);
        await window.ZPI.archiveSession(created.value.id);
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
      const records = await window.ZPI.listArchivedSessions();
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
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("composer focus restores per-task caret on switch/restart and terminal tabs receive focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-input-focus-"));
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
          const id = localStorage.getItem("ZPI.selectedSession");
          if (!id) return;
          const draft = await window.ZPI.getDraft(id);
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
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
