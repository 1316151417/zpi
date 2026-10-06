import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expectZCodeSystemFont } from "../helpers/rendered-fonts.ts";

test("sidebar headings match ZCode hover states and dimensions; project menu only removes its entry", async () => {
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
    // ZCode Root uses 1.5 for all icons; navigation stays 16px.
    for (const selector of [".sidebar-global svg", ".sidebar-footer svg"]) {
      await expect(page.locator(selector)).toHaveCSS("width", "16px");
      await expect(page.locator(selector)).toHaveCSS("stroke-width", "1.5px");
    }
    await expectZCodeSystemFont(page, [
      ".sidebar-global button",
      ".sidebar-footer button",
      ".section-toggle span",
    ]);
    if (process.platform === "darwin") {
      // Measured in ZCode at 14px/500, zoom 1; PingFang SC would be 28px.
      expect((await projectHeader.locator(".section-toggle span").boundingBox())?.width).toBeCloseTo(
        26.84375,
        2,
      );
    }

    const colors = await page.evaluate(() => {
      const probe = document.createElement("span");
      document.body.append(probe);
      const color = (token: string) => {
        probe.style.color = `var(${token})`;
        return getComputedStyle(probe).color;
      };
      const result = {
        foreground: color("--color-foreground"),
        subtlest: color("--color-text-subtlest"),
        subtle: color("--color-text-subtle"),
      };
      probe.remove();
      return result;
    });
    for (const header of [projectHeader, taskHeader]) {
      await editor.focus();
      await editor.hover();
      const chevron = header.locator(".section-toggle svg");
      const actions = header.locator(".sidebar-heading-actions");
      const action = actions.locator(".muted-icon");
      const toggle = header.locator(".section-toggle");
      const handle = actions.locator(".section-drag-handle");
      await expect(chevron).toHaveCSS("opacity", "0");
      await expect(actions).toHaveCSS("opacity", "0");
      await expect(toggle).toHaveCSS("color", colors.subtlest);
      await expect(action).toHaveCSS("color", colors.subtle);
      await expect(toggle).toHaveCSS("font-size", "14px");
      await expect(toggle).toHaveCSS("font-weight", "500");
      await expect(toggle).toHaveCSS("height", "28px");
      await expect(toggle).toHaveCSS("column-gap", "4px");
      await expect(handle).toHaveCSS("width", "24px");
      await expect(handle.locator("svg")).toHaveCSS("width", "14px");
      for (const icon of await header.locator("svg").all()) {
        await expect(icon).toHaveCSS("stroke-width", "1.5px");
      }
      await header.hover();
      await expect(chevron).toHaveCSS("opacity", "1");
      await expect(actions).toHaveCSS("opacity", "1");
      await toggle.hover();
      await expect(toggle).toHaveCSS("color", colors.foreground);
      await expect(chevron).toHaveCSS("color", colors.foreground);
      await handle.hover({ position: { x: 4, y: 4 } });
      await expect(toggle).toHaveCSS("color", colors.subtlest);
      await expect(handle).toHaveCSS("color", colors.foreground);
      await action.hover();
      await expect(action).toHaveCSS("color", colors.foreground);
      await expect(handle).toHaveCSS("color", colors.subtlest);
      await editor.hover();
      await toggle.focus();
      await expect(toggle).toHaveCSS("color", colors.foreground);
      await expect(actions).toHaveCSS("opacity", "1");
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
      expect(background).toBe("rgba(0, 0, 0, 0)");
      await header.locator(".section-toggle").hover();
      await expect(header.locator(".section-toggle")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(header).toHaveCSS("background-color", background);
      await header.locator(".muted-icon").hover();
      await expect(header.locator(".muted-icon")).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(header).toHaveCSS("background-color", background);
    }
    await projectHeader.hover();
    await projectHeader.screenshot({ path: "test-results/sidebar-project-heading.png" });
    await projectHeader.hover();
    await projectHeader.getByLabel("添加项目", { exact: true }).click();
    const projectRow = page.locator(".project-title");
    const folderToggle = projectRow.locator(".project-toggle");
    const folderIcon = folderToggle.locator("svg");
    await expect(folderIcon).toHaveClass(/lucide-folder-open/);
    await expect(folderIcon).toHaveCSS("width", "14px");
    await expect(folderIcon).toHaveCSS("height", "14px");
    await expect(folderIcon).toHaveCSS("stroke-width", "1.5px");
    const slot = await folderToggle.boundingBox();
    const icon = await folderIcon.boundingBox();
    expect(icon?.x).toBe((slot?.x ?? 0) + 1);
    await folderToggle.click();
    await expect(folderIcon).toHaveClass(/lucide-folder(?!-open)/);
    await expect(folderIcon).toHaveCSS("width", "14px");
    await expect(folderIcon).toHaveCSS("stroke-width", "1.5px");
    await folderToggle.click();
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
    await more.click();
    const directoryMenu = page.getByRole("menu", { name: "项目操作 project", exact: true });
    await expect(directoryMenu.getByRole("menuitem")).toHaveText(["移除", "Finder", "复制路径"]);
    await expect(directoryMenu.getByRole("separator")).toHaveCSS("border-top-style", "dashed");
    const finder = directoryMenu.getByRole("menuitem", { name: "Finder", exact: true });
    await expect(finder.locator("img")).toHaveAttribute("src", /\/file-actions\/finder\.png$/);
    await expect(finder.locator("img")).toHaveCSS("width", "16px");
    await expect(
      directoryMenu.getByRole("menuitem", { name: "复制路径", exact: true }).locator("svg"),
    ).toHaveClass(/lucide-copy/);
    await directoryMenu.getByRole("menuitem", { name: "复制路径", exact: true }).click();
    await expect
      .poll(() => app?.evaluate(({ clipboard }) => clipboard.readText()))
      .toBe(await realpath(project));
    await app.evaluate(({ shell }) => {
      shell.openPath = async (path) => {
        (globalThis as typeof globalThis & { openedDirectory: string }).openedDirectory = path;
        return "";
      };
    });
    await projectRow.hover();
    await more.click();
    await finder.click();
    await expect
      .poll(() =>
        app?.evaluate(() => (globalThis as typeof globalThis & { openedDirectory?: string }).openedDirectory),
      )
      .toBe(await realpath(project));
    await expect(page.getByTestId("run")).toHaveCount(0);
    await projectRow.hover();
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
    await editor.focus();
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
    await expect(menu.getByRole("menuitem")).toHaveText(["移除", "Finder", "复制路径"]);
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
    await page.evaluate(() => window.ZPI.updatePreferences({ theme: "dark", fontSize: 18 }));
    await page.reload();
    await editor.focus();
    await editor.hover();
    const foreground = await page.locator("body").evaluate((el) => getComputedStyle(el).color);
    for (const header of [projectHeader, taskHeader]) {
      const toggle = header.locator(".section-toggle");
      const handle = header.locator(".section-drag-handle");
      await expect(toggle).toHaveCSS("font-size", "18px");
      await expect(toggle).toHaveCSS("height", "28px");
      await toggle.hover();
      await expect(toggle).toHaveCSS("color", foreground);
      await expect(toggle.locator("svg")).toHaveCSS("width", "14px");
      await handle.hover({ position: { x: 4, y: 4 } });
      await expect(handle).toHaveCSS("color", foreground);
      await expect(handle).toHaveCSS("background-color", "rgba(255, 255, 255, 0.05)");
    }
    await projectHeader.screenshot({ path: "test-results/sidebar-project-heading-dark.png" });
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("project directory actions preserve literal paths and report Finder failures", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-project-directory-"));
  const project = join(dir, "project # % 项目 ");
  await mkdir(project);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    await app.evaluate(({ shell }) => {
      shell.openPath = async (path) => {
        (globalThis as typeof globalThis & { openedDirectory: string }).openedDirectory = path;
        return "";
      };
    });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).click();
    const row = page.locator(".project-title");
    const more = row.getByTitle("更多", { exact: true });
    const menu = page.getByRole("menu");
    await row.hover();
    await more.click();
    await menu.getByRole("menuitem", { name: "复制路径", exact: true }).click();
    const path = await realpath(project);
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toBe(path);
    await row.hover();
    await more.click();
    await menu.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect
      .poll(() =>
        app?.evaluate(() => (globalThis as typeof globalThis & { openedDirectory?: string }).openedDirectory),
      )
      .toBe(path);
    await app.evaluate(({ shell }) => {
      shell.openPath = async () => "无法打开项目目录";
    });
    await row.hover();
    await more.click();
    await menu.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("无法打开项目目录");
    await expect(row).toHaveCount(1);
  } finally {
    await app?.close();
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
    await expectZCodeSystemFont(page, [".session-name-text"]);

    // ZCode: text-ui-base headings/names, medium headings, normal names,
    // 28px purpose headers and 24px task text slots inside 32px rows.
    for (const size of [14, 18, 14]) {
      await page.evaluate((fontSize) => window.ZPI.updatePreferences({ fontSize }), size);
      await page.reload();
      const headings = page.locator(".section-toggle");
      const names = page.locator(".sidebar .project-name, .sidebar .session-name");
      for (const text of [...(await headings.all()), ...(await names.all())]) {
        await expect(text).toHaveCSS("font-size", `${size}px`);
        await expect(text).toHaveCSS("line-height", `${size * 1.5}px`);
        await expect(text).toHaveCSS("font-family", /^ui-sans-serif, system-ui, sans-serif,/);
        await expect(text).toHaveCSS("letter-spacing", "normal");
      }
      for (const heading of await headings.all()) {
        await expect(heading).toHaveCSS("font-weight", "500");
        await expect(heading).toHaveCSS("height", "28px");
      }
      for (const name of await names.all()) await expect(name).toHaveCSS("font-weight", "400");
      for (const row of await page.locator(".sidebar .session-row").all()) {
        await expect(row).toHaveCSS("height", "32px");
        await expect(row).toHaveCSS("padding-top", "4px");
        await expect(row.locator(".session-name")).toHaveCSS("height", "24px");
      }
      await expect(page.locator(".project-title")).toHaveCSS("height", "32px");
    }
    await page.locator(".sidebar").screenshot({ path: "test-results/sidebar-typography.png" });
    await page.locator(".projects .session-row").hover();
    await page.getByLabel("置顶任务 项目任务", { exact: true }).click();
    await expectGroup("项目任务", ".pinned-tasks");
    await page.getByLabel("任务菜单", { exact: true }).click();
    await page.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expectGroup("独立任务", ".pinned-tasks");
    const pinnedHeading = page.locator(".pinned-tasks .sidebar-heading");
    await expect(pinnedHeading).toHaveText("已置顶");
    await page.getByLabel("消息", { exact: true }).hover();
    const pinnedColor = await pinnedHeading.evaluate((el) => getComputedStyle(el).color);
    await pinnedHeading.hover();
    await expect(pinnedHeading).toHaveCSS("color", pinnedColor);
    await expect(pinnedHeading).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
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

test("sidebar section handles reorder with keyboard and pointer and preserve order after restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-sidebar-order-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    let page = await app.firstWindow();
    const sections = () => page.locator("[data-sidebar-section]");
    const order = async () =>
      sections().evaluateAll((els) => els.map((el) => el.getAttribute("data-sidebar-section")));
    await expect(sections()).toHaveCount(2);
    expect(await order()).toEqual(["projects", "tasks"]);
    await page.getByLabel("收起项目列表", { exact: true }).click();
    await page.getByLabel("收起任务列表", { exact: true }).click();
    await expect(page.locator(".projects")).toBeHidden();
    await expect(page.locator(".recent-sessions")).toBeHidden();
    const handle = page.getByLabel("移动项目分区", { exact: true });
    await handle.focus();
    await handle.press("Space");
    await expect(handle).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator("[role=status]")).toContainText(
      "projects was moved over droppable area projects",
    );
    // dnd-kit announces activation before its deferred key listener and layout
    // measurements are ready. Let the activation render finish before moving.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await handle.press("ArrowDown");
    await expect(page.locator("[role=status]")).toContainText("droppable area tasks");
    await handle.press("Space");
    await expect.poll(order).toEqual(["tasks", "projects"]);
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    page = await app.firstWindow();
    await expect.poll(order).toEqual(["tasks", "projects"]);
    await expect(page.getByLabel("展开项目列表", { exact: true })).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByLabel("展开任务列表", { exact: true })).toHaveAttribute("aria-expanded", "false");
    const source = await page.getByLabel("移动项目分区", { exact: true }).boundingBox();
    const target = await page.getByLabel("移动任务分区", { exact: true }).boundingBox();
    if (!source || !target) throw new Error("Missing section handles");
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(order).toEqual(["projects", "tasks"]);
    await page.reload();
    await expect.poll(order).toEqual(["projects", "tasks"]);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
