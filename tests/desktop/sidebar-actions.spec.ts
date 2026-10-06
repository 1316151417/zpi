import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("sidebar headers reveal trailing chevrons and contextual actions; project menu only removes its entry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-sidebar-actions-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "keep.txt"), "project source");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    const projectHeader = page.locator(".sidebar-heading").filter({ hasText: /^项目$/ });
    const taskHeader = page.locator(".sidebar-heading").filter({ hasText: /^任务$/ });
    await expect(page.locator(".topbar-title")).toHaveText("新任务");

    for (const header of [projectHeader, taskHeader]) {
      await editor.focus();
      await editor.hover();
      const chevron = header.locator(".section-toggle svg");
      const action = header.locator(".muted-icon");
      await expect(chevron).toHaveCSS("opacity", "0");
      await expect(action).toHaveCSS("opacity", "0");
      await header.hover();
      await expect(chevron).toHaveCSS("opacity", "1");
      await expect(action).toHaveCSS("opacity", "1");
      const labelBox = await header.locator(".section-toggle span").boundingBox();
      const iconBox = await chevron.boundingBox();
      expect(iconBox?.x).toBeGreaterThan((labelBox?.x ?? 0) + (labelBox?.width ?? 0));
    }
    await expect(taskHeader.locator("svg.lucide-message-circle-plus")).toHaveCount(1);
    await expect(
      projectHeader.getByLabel("添加项目", { exact: true }).locator("svg.lucide-plus"),
    ).toHaveCount(1);
    for (const header of [projectHeader, taskHeader]) {
      await header.hover();
      const background = await header.evaluate((el) => getComputedStyle(el).backgroundColor);
      expect(background).not.toBe("rgba(0, 0, 0, 0)");
      await header.locator(".section-toggle").hover();
      await expect(header.locator(".section-toggle")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(header).toHaveCSS("background-color", background);
      await header.locator(".muted-icon").hover();
      await expect(header).toHaveCSS("background-color", background);
    }
    await projectHeader.hover();
    await projectHeader.screenshot({ path: "test-results/sidebar-project-heading.png" });
    await projectHeader.hover();
    await projectHeader.getByLabel("添加项目", { exact: true }).click();
    const projectRow = page.locator(".project-title");
    const more = projectRow.getByLabel("项目操作 project", { exact: true });
    const create = projectRow.getByLabel("新建任务 project", { exact: true });
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("project");
    await expect(page.locator(".topbar-title")).toHaveText("新任务");
    await expect(projectRow.getByRole("button", { name: /重命名项目|移除项目/ })).toHaveCount(0);
    await editor.focus();
    await editor.hover();
    await expect(more).toHaveCSS("opacity", "0");
    await expect(create).toHaveCSS("opacity", "0");
    await projectRow.hover();
    await expect(more).toHaveCSS("opacity", "1");
    await expect(create).toHaveCSS("opacity", "1");
    await expect(create.locator("svg.lucide-message-circle-plus")).toHaveCount(1);
    await expect(more.locator("svg.lucide-ellipsis")).toHaveCount(1);
    await page.locator(".sidebar").screenshot({ path: "test-results/sidebar-project-actions.png" });

    await editor.fill("项目任务");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".topbar-title")).toHaveText("项目任务");
    await expect(page.locator(".projects .session-name")).toHaveText("项目任务");
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(0);
    await projectRow.hover();
    await create.click();
    await expect(page.locator(".topbar-title")).toHaveText("新任务");
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("project");
    await taskHeader.hover();
    await taskHeader.getByLabel("新建任务", { exact: true }).click();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("选择项目");

    await projectHeader.getByRole("button", { name: "收起项目列表", exact: true }).click();
    await expect(page.locator(".projects")).toBeHidden();
    await editor.hover();
    await expect(projectHeader.locator(".section-toggle svg")).toHaveCSS("opacity", "0");
    await page.reload();
    await expect(page.locator(".projects")).toBeHidden();
    await projectHeader.hover();
    await projectHeader.getByRole("button", { name: "展开项目列表", exact: true }).click();
    await taskHeader.hover();
    await taskHeader.getByRole("button", { name: "收起任务列表", exact: true }).click();
    await expect(page.locator(".recent-sessions")).toBeHidden();
    await taskHeader.getByRole("button", { name: "展开任务列表", exact: true }).click();
    await expect(taskHeader.getByRole("button", { name: "收起任务列表", exact: true })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(page.locator(".recent-sessions")).not.toHaveAttribute("hidden");

    await projectRow.hover();
    await more.click();
    const menu = page.getByRole("menu", { name: "项目操作 project", exact: true });
    await expect(menu.getByRole("menuitem")).toHaveText(["移除"]);
    await menu.hover();
    await expect(more).toHaveCSS("opacity", "1");
    await menu.press("Escape");
    await expect(menu).toHaveCount(0);
    await expect(more).toBeFocused();
    await editor.focus();
    await editor.hover();
    await expect(more).toHaveCSS("opacity", "0");
    await more.focus();
    await more.press("Enter");
    await expect(menu).toBeVisible();
    await menu.screenshot({ path: "test-results/sidebar-project-menu.png" });
    await menu.getByRole("menuitem", { name: "移除", exact: true }).click();
    await expect(projectRow).toHaveCount(0);
    await expect(
      page.locator(".recent-sessions").getByRole("button", { name: "项目任务", exact: true }),
    ).toBeVisible();
    expect(await readFile(join(project, "keep.txt"), "utf8")).toBe("project source");
    await page.reload();
    await expect(projectRow).toHaveCount(0);
    await projectHeader.hover();
    await projectHeader.getByLabel("添加项目", { exact: true }).click();
    await expect(projectRow).toHaveCount(1);
    await expect(
      page.locator(".projects").getByRole("button", { name: "项目任务", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("tasks appear in one section and return to their original group after unpinning and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-sidebar-groups-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    const expectGroup = async (title: string, group: string) => {
      await expect(page.locator(".sidebar").getByRole("button", { name: title, exact: true })).toHaveCount(1);
      for (const section of [".projects", ".recent-sessions", ".pinned-tasks"]) {
        await expect(page.locator(section).getByRole("button", { name: title, exact: true })).toHaveCount(
          section === group ? 1 : 0,
        );
      }
    };
    await page.getByLabel("添加项目", { exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("项目任务");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const taskHeader = page.locator(".sidebar-heading").filter({ hasText: /^任务$/ });
    await taskHeader.getByLabel("新建任务", { exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("独立任务");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expectGroup("项目任务", ".projects");
    await expectGroup("独立任务", ".recent-sessions");

    await page.locator(".projects .session-row").hover();
    await page.getByLabel("置顶任务 项目任务", { exact: true }).click();
    await expectGroup("项目任务", ".pinned-tasks");
    await page.getByLabel("任务菜单", { exact: true }).click();
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expectGroup("独立任务", ".pinned-tasks");
    await page.locator(".sidebar").screenshot({ path: "test-results/sidebar-exclusive-pinned.png" });
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    await expectGroup("项目任务", ".pinned-tasks");
    await expectGroup("独立任务", ".pinned-tasks");

    await page.locator(".pinned-tasks .session-row").filter({ hasText: "项目任务" }).hover();
    await page.getByLabel("取消置顶任务 项目任务", { exact: true }).click();
    await expectGroup("项目任务", ".projects");
    await page.getByLabel("任务菜单", { exact: true }).click();
    await page.getByRole("menuitem", { name: "取消置顶", exact: true }).click();
    await expectGroup("独立任务", ".recent-sessions");
    await expect(page.locator(".pinned-tasks")).toHaveCount(0);
    await page.reload();
    await expectGroup("项目任务", ".projects");
    await expectGroup("独立任务", ".recent-sessions");
    await page.locator(".sidebar").screenshot({ path: "test-results/sidebar-exclusive-groups.png" });
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
