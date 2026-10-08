import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expectZCodeSystemFont } from "../helpers/rendered-fonts.ts";

test("empty project and independent task lists match ZCode spacing, fonts and theme colors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-sidebar-empty-"));
  const project = join(dir, "empty-project");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    await page.getByLabel("添加项目", { exact: true }).click();
    const projectEmpty = page.locator(".projects .task-list-empty");
    const taskEmpty = page.locator('[data-sidebar-section="tasks"] .task-list-empty');
    for (const [theme, size] of [
      ["light", 14],
      ["dark", 18],
    ] as const) {
      await page.evaluate(({ theme, fontSize }) => window.ZPI.updatePreferences({ theme, fontSize }), {
        theme,
        fontSize: size,
      });
      await page.reload();
      await expect(projectEmpty).toHaveText("暂无任务");
      await expect(taskEmpty).toHaveText("还没有任务");
      for (const empty of [projectEmpty, taskEmpty]) {
        await expect(empty).toHaveCSS("font-size", `${size}px`);
        await expect(empty).toHaveCSS("font-weight", "400");
        await expect(empty).toHaveCSS("line-height", `${size * 1.5}px`);
        await expect(empty).toHaveCSS("padding-top", "8px");
        await expect(empty).toHaveCSS("padding-bottom", "8px");
      }
      await expect(projectEmpty).toHaveCSS("padding-left", "34px");
      await expect(taskEmpty).toHaveCSS("padding-left", "12px");
      await expectZCodeSystemFont(page, [
        ".projects .task-list-empty",
        '[data-sidebar-section="tasks"] .task-list-empty',
      ]);
      const metrics = await page.evaluate(() => {
        const projectEmpty = document.querySelector(".projects .task-list-empty") as HTMLElement;
        const taskEmpty = document.querySelector(
          '[data-sidebar-section="tasks"] .task-list-empty',
        ) as HTMLElement;
        const projectTitle = document.querySelector(".project-title") as HTMLElement;
        const taskHeading = document.querySelector(
          '[data-sidebar-section="tasks"] .sidebar-heading',
        ) as HTMLElement;
        const textRect = (el: HTMLElement) => {
          const range = document.createRange();
          range.selectNodeContents(el);
          return range.getBoundingClientRect();
        };
        const probe = document.createElement("span");
        document.body.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          projectColor: getComputedStyle(projectEmpty).color,
          taskColor: getComputedStyle(taskEmpty).color,
          subtlest: color("--color-text-subtlest"),
          subtle: color("--color-text-subtle"),
          projectTextX: textRect(projectEmpty).x,
          taskTextX: textRect(taskEmpty).x,
          projectGap: projectEmpty.getBoundingClientRect().top - projectTitle.getBoundingClientRect().bottom,
          sectionGap: taskHeading.getBoundingClientRect().top - projectEmpty.getBoundingClientRect().bottom,
          taskGap: taskEmpty.getBoundingClientRect().top - taskHeading.getBoundingClientRect().bottom,
        };
        probe.remove();
        return result;
      });
      expect(metrics.projectColor).toBe(metrics.subtlest);
      expect(metrics.taskColor).toBe(metrics.subtle);
      expect(metrics.projectTextX).toBe(42);
      expect(metrics.taskTextX).toBe(20);
      expect(metrics.projectGap).toBe(8);
      expect(metrics.sectionGap).toBe(16);
      expect(metrics.taskGap).toBe(0);
      await page.locator(".sidebar").screenshot({ path: `test-results/sidebar-empty-${theme}.png` });
    }
    await page.getByLabel("收起项目 empty-project", { exact: true }).click();
    await expect(projectEmpty).toHaveCount(0);
    await expect(taskEmpty).toBeVisible();
    await page.getByLabel("展开项目 empty-project", { exact: true }).click();
    await expect(projectEmpty).toBeVisible();
    await page.getByLabel("收起任务列表", { exact: true }).click();
    await expect(taskEmpty).toHaveCount(0);
    await page.getByLabel("展开任务列表", { exact: true }).click();
    await expect(taskEmpty).toBeVisible();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("项目任务");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".projects .session-row")).toHaveCount(1);
    await expect(projectEmpty).toHaveCount(0);
    await expect(taskEmpty).toBeVisible();
    const row = page.locator(".projects .session-row");
    await row.hover();
    await row.getByLabel("归档任务 项目任务", { exact: true }).click();
    await expect(projectEmpty).toBeVisible();
    await page.reload();
    await expect(projectEmpty).toBeVisible();
    await page.locator('[data-sidebar-section="tasks"]').getByLabel("新建任务", { exact: true }).click();
    await editor.fill("独立任务");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(taskEmpty).toHaveCount(0);
    await expect(projectEmpty).toBeVisible();
    const independent = page.locator(".recent-sessions .session-row");
    await independent.hover();
    await independent.getByLabel("归档任务 独立任务", { exact: true }).click();
    await expect(taskEmpty).toHaveText("还没有任务");
    await page.getByLabel("筛选和排序", { exact: true }).click();
    await page.getByRole("menuitemradio", { name: "时间线" }).click();
    await expect(page.locator(".task-list-empty")).toHaveText("暂无任务");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
