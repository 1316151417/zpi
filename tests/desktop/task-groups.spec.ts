import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { expectNoCornerTooltipDuring } from "../helpers/tooltip.ts";
import { seedHistory } from "../history-fixture.ts";

async function expectToolbarFits(page: Page) {
  await expect
    .poll(() =>
      page.locator(".sidebar-task-toolbar").evaluate((toolbar) => {
        const sidebar = toolbar.closest(".sidebar");
        if (!sidebar) throw new Error("Missing sidebar");
        const bounds = sidebar.getBoundingClientRect();
        return Array.from(toolbar.querySelectorAll("button")).flatMap((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left < bounds.left || rect.right > bounds.right || rect.width < 24
            ? [
                {
                  label: button.ariaLabel ?? button.textContent,
                  width: rect.width,
                  overflow: rect.right - bounds.right,
                },
              ]
            : [];
        });
      }),
    )
    .toEqual([]);
}

async function grouped(page: Page) {
  await page.getByRole("button", { name: "筛选视图", exact: true }).click();
  await page.getByRole("menuitemradio", { name: "按分组", exact: true }).click();
  await expect(page.getByRole("button", { name: "新建分组", exact: true })).toBeVisible();
}
async function createGroup(page: Page, name: string) {
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  const input = page.getByRole("textbox", { name: "重命名分组", exact: true });
  await expect(input).toBeFocused();
  await expect(page.getByRole("menuitemradio", { name: "灰色", exact: true })).toBeVisible();
  await input.fill(name);
  await input.press("Enter");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("menuitemradio", { name: "灰色", exact: true })).toBeHidden();
  await expect(page.getByRole("button", { name: `分组 ${name}`, exact: true })).toBeVisible();
}

test("grouped tasks keep manual order while the shared view menu preserves independent project and recent-update views", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-sort-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const now = Date.now();
  for (const [id, createdAt, updatedAt] of [
    ["root-old", now - 400000, now - 60000],
    ["root-new", now - 300000, now - 200000],
    ["group-old", now - 200000, now - 60000],
    ["group-new", now - 100000, now - 100000],
  ] as const)
    seedHistory(dir, project, 0, { id, createdAt, updatedAt });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const created = await window.zpi.updateTaskGroups({ type: "create" });
      if (!created.ok) throw new Error(created.error.message);
      const groupId = created.value.groups[0].id;
      for (const id of ["group-new", "group-old"]) {
        const result = await window.zpi.updateTaskGroups({ type: "moveTask", id, groupId });
        if (!result.ok) throw new Error(result.error.message);
      }
      const ordered = await window.zpi.updateTaskGroups({ type: "taskTop", id: "root-new" });
      if (!ordered.ok) throw new Error(ordered.error.message);
    });
    await page.reload();
    await grouped(page);
    await expectToolbarFits(page);
    const rootRows = page.locator(".task-groups > .grouped-task-wrapper [data-testid=session-row]");
    const groupRows = page.locator(".task-group-content [data-testid=session-row]");
    const ids = (rows: typeof rootRows) =>
      rows.evaluateAll((elements) => elements.map((row) => row.getAttribute("data-session-id")));
    await expect.poll(() => ids(rootRows)).toEqual(["root-new", "root-old"]);
    await expect.poll(() => ids(groupRows)).toEqual(["group-new", "group-old"]);
    await expect(page.getByRole("button", { name: "筛选视图", exact: true })).toBeVisible();
    await rootRows.first().hover();
    await expect(rootRows.first().getByRole("button", { name: /^移动到顶部 / })).toBeVisible();
    const workspaceTooltip = page.getByRole("tooltip", { name: "workspace", exact: true });
    await expect(workspaceTooltip).toBeVisible();
    await expect(workspaceTooltip).toHaveText("workspace");
    await page.screenshot({ path: test.info().outputPath("grouped-manual-order.png") });
    const second = rootRows.nth(1);
    await second.hover();
    await second.getByRole("button", { name: /^移动到顶部 / }).click();
    await expect.poll(() => ids(rootRows)).toEqual(["root-old", "root-new"]);
    await page.reload();
    await grouped(page);
    await expect.poll(() => ids(rootRows)).toEqual(["root-old", "root-new"]);
    await expect.poll(() => ids(groupRows)).toEqual(["group-new", "group-old"]);
    expect(
      await page.evaluate(async () => {
        const result = await window.zpi.getTaskGroups();
        if (!result.ok) throw new Error(result.error.message);
        return result.value.roots.filter((node) => node.type === "task").map((node) => node.id);
      }),
    ).toEqual(["root-old", "root-new"]);
    await page.getByRole("button", { name: "筛选视图", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "按项目", exact: true }).click();
    await page.getByRole("button", { name: "筛选视图", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "按项目", exact: true })).toBeChecked();
    await expect(page.getByRole("menuitemradio")).toHaveCount(3);
    await page.getByRole("menuitemradio", { name: "最近更新", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "筛选视图", exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "最近更新", exact: true })).toBeChecked();
    await page.getByRole("menuitemradio", { name: "按分组", exact: true }).click();
    await expect.poll(() => ids(rootRows)).toEqual(["root-old", "root-new"]);
    await expect.poll(() => ids(groupRows)).toEqual(["group-new", "group-old"]);
    await page.evaluate(async () => {
      const result = await window.zpi.updatePreferences({ sidebarWidth: 200, fontSize: 20 });
      if (!result.ok) throw new Error(result.error.message);
    });
    await page.reload();
    await grouped(page);
    await expectToolbarFits(page);
    await page.screenshot({ path: test.info().outputPath("grouped-narrow-toolbar.png") });
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("grouped task drag persists the dropped order through reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-task-drag-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const now = Date.now();
  seedHistory(dir, project, 0, { id: "drag-a", createdAt: now - 2000, updatedAt: now - 2000 });
  seedHistory(dir, project, 0, { id: "drag-b", createdAt: now - 1000, updatedAt: now - 1000 });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await grouped(page);
    const rootRows = page.locator(".task-groups > .grouped-task-wrapper [data-testid=session-row]");
    const ids = () =>
      rootRows.evaluateAll((elements) => elements.map((row) => row.getAttribute("data-session-id")));
    const roots = () =>
      page.evaluate(async () => {
        const result = await window.zpi.getTaskGroups();
        if (!result.ok) throw new Error(result.error.message);
        return result.value.roots.filter((node) => node.type === "task").map((node) => node.id);
      });
    const initial = await ids();
    expect(initial).toHaveLength(2);
    const source = await rootRows.nth(0).boundingBox();
    const target = await rootRows.nth(1).boundingBox();
    if (!source || !target) throw new Error("missing task row bounds");
    await page.mouse.move(source.x + 40, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    const expected = [initial[1], initial[0]];
    await expect.poll(ids).toEqual(expected);
    await expect.poll(roots).toEqual(expected);
    await page.reload();
    await grouped(page);
    await expect.poll(ids).toEqual(expected);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("grouped group drag persists the dropped order through reload", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-group-drag-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await grouped(page);
    await createGroup(page, "拖拽甲");
    await createGroup(page, "拖拽乙");
    const state = await page.evaluate(async () => {
      const result = await window.zpi.getTaskGroups();
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    const initial = state.roots.filter((node) => node.type === "group").map((node) => node.id);
    expect(initial).toHaveLength(2);
    const title = (id: string) => state.groups.find((group) => group.id === id)?.title;
    const groupOrder = () =>
      page.evaluate(async () => {
        const result = await window.zpi.getTaskGroups();
        if (!result.ok) throw new Error(result.error.message);
        return result.value.roots.filter((node) => node.type === "group").map((node) => node.id);
      });
    const sourceHeader = page.getByRole("button", { name: `分组 ${title(initial[0])}`, exact: true });
    const targetHeader = page.getByRole("button", { name: `分组 ${title(initial[1])}`, exact: true });
    const source = await sourceHeader.locator(".task-group-title").boundingBox();
    const target = await targetHeader.boundingBox();
    if (!source || !target) throw new Error("missing group header bounds");
    await page.mouse.move(source.x + 8, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(target.x + 40, target.y + target.height / 2, { steps: 10 });
    await page.mouse.up();
    const expected = [initial[1], initial[0]];
    await expect.poll(groupOrder).toEqual(expected);
    await page.reload();
    await grouped(page);
    await expect.poll(groupOrder).toEqual(expected);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("grouped task archive uses the menu icon and retains history while draft X discards the draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-archive-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "已保留的任务历史" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await expect(page.getByLabel("选择项目", { exact: true })).toContainText("workspace");
    await page.getByLabel("消息", { exact: true }).fill("归档按钮验证");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const task = await page.evaluate(async () => {
      const result = await window.zpi.listRecentSessions();
      if (!result.ok) throw new Error(result.error.message);
      const task = result.value.find((record) => !record.draft);
      if (!task) throw new Error("missing created task");
      return task;
    });
    await grouped(page);
    const row = page.locator(`[data-testid="session-row"][data-session-id="${task.id}"]`);
    await row.hover();
    const archive = row.getByRole("button", { name: "归档任务", exact: true });
    await expect(archive.locator("svg.lucide-archive")).toHaveCount(1);
    await expect(archive.locator("svg.lucide-x")).toHaveCount(0);
    await archive.hover();
    await expect(page.getByRole("tooltip", { name: "归档任务", exact: true })).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("grouped-archive.png") });
    await expectNoCornerTooltipDuring(page, () => page.getByLabel("消息", { exact: true }).hover());
    await expect(archive).toBeHidden();
    await row.hover();
    await expect(page.getByRole("tooltip", { name: "归档任务", exact: true })).toHaveCount(0);
    await archive.focus();
    await expect(page.getByRole("tooltip", { name: "归档任务", exact: true })).toHaveCount(0);
    await expectNoCornerTooltipDuring(page, () => page.getByLabel("消息", { exact: true }).focus());
    await row.hover();
    await archive.click();
    await expect(row).toHaveCount(0);
    const archived = await page.evaluate(() => window.zpi.listArchivedSessions());
    expect(archived.ok && archived.value.some((record) => record.id === task.id)).toBe(true);
    const snapshot = await page.evaluate((id) => window.zpi.getSessionSnapshot(id), task.id);
    expect(snapshot.ok && snapshot.value.view.runs.length).toBe(1);
    await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
    const draft = page.getByTestId("grouped-draft-row");
    await expect(draft).toBeVisible();
    const draftId = await draft.getAttribute("data-session-id");
    await draft.hover();
    const discard = draft.getByRole("button", { name: "关闭新任务", exact: true });
    await expect(discard.locator("svg.lucide-x")).toHaveCount(1);
    await expect(draft.locator("svg.lucide-archive")).toHaveCount(0);
    await discard.click();
    await expect(draft).toHaveCount(0);
    const remaining = await page.evaluate(() => window.zpi.listRecentSessions());
    expect(remaining.ok && remaining.value.some((record) => record.id === draftId)).toBe(false);
    const after = await page.evaluate(() => window.zpi.listArchivedSessions());
    expect(after.ok && after.value.map((record) => record.id)).toEqual([task.id]);
    await page.reload();
    await expect(page.locator(`[data-session-id="${draftId}"]`)).toHaveCount(0);
    await expect(row).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("grouped running task fades archive and explains why it is disabled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-running-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const server = await fakeServer((_, response) => send(response, chunk({ content: "live response" })));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await expect(page.getByLabel("选择项目", { exact: true })).toContainText("workspace");
    await page.getByLabel("消息", { exact: true }).fill("运行中的任务");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    await grouped(page);
    const row = page.locator(".task-groups [data-testid=session-row]").first();
    await row.hover();
    const archive = row.getByRole("button", { name: "归档任务", exact: true });
    await expect(archive).toBeDisabled();
    await expect(archive).toHaveCSS("opacity", "0.45");
    await archive.hover();
    await expect(page.getByRole("tooltip", { name: "请先停止运行", exact: true })).toBeVisible();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("group menus preserve focus/expansion, names/IME and colors survive reload, and ungroup keeps tasks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-groups-ui-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const seeded = seedHistory(dir, project, 1);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await grouped(page);
    await createGroup(page, "设计组");
    const header = page.getByRole("button", { name: "分组 设计组", exact: true });
    await expect(header).toHaveAttribute("aria-expanded", "true");
    for (const expanded of [true, false]) {
      if (!expanded) await header.click();
      await page.getByRole("button", { name: "分组颜色 设计组", exact: true }).click();
      const option = page.getByRole("menuitemradio", { name: expanded ? "紫色" : "绿色", exact: true });
      await expect(option).toBeVisible();
      await option.click();
      await expect(option).toBeHidden();
      await expect(header).toHaveAttribute("aria-expanded", String(expanded));
    }
    await header.click({ button: "right" });
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    const input = page.getByRole("textbox", { name: "重命名分组" });
    await expect(input).toBeFocused();
    await input.fill("中文输入中");
    await input.dispatchEvent("compositionstart");
    await input.press("Enter");
    await expect(input).toBeVisible();
    await input.dispatchEvent("compositionend");
    await input.press("Escape");
    await expect(header).toBeVisible();
    await page.reload();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await expect(header.locator(".task-group-color-mark")).toHaveAttribute("data-group-color", "green");
    const row = page.locator(`.task-groups [data-session-id="${seeded.id}"]`);
    await row.click({ button: "right" });
    await page.getByRole("menuitem", { name: "移动到分组", exact: true }).hover();
    await page.getByRole("menuitem", { name: "设计组", exact: true }).click();
    await header.click();
    await expect(header.locator(".task-group-count")).toHaveText("1");
    await expect(page.locator(".task-group-content").getByTestId("session-row")).toHaveCount(1);
    await header.click({ button: "right" });
    await page.getByRole("menuitem", { name: "取消分组并删除", exact: true }).click();
    await expect(header).toHaveCount(0);
    await expect(row).toBeVisible();
    await page.reload();
    await expect(row).toBeVisible();
    await expect(page.locator(".task-group")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("virtualized group headers stay above their task rows while groups expand and the sidebar scrolls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-layout-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const rootCount = 90;
  const ids = Array.from(
    { length: rootCount + 24 },
    (_, index) => seedHistory(dir, project, 0, { id: `layout-task-${index}` }).id,
  );
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 862));
    const groups = await page.evaluate(
      async ({ tasks, rootCount }) => {
        const groups: { id: string; title: string }[] = [];
        let offset = rootCount;
        for (const [title, count] of [
          ["知识库", 8],
          ["8.18 迭代", 7],
          ["8.19 迭代", 8],
          ["技术优化", 1],
        ] as const) {
          const created = await window.zpi.updateTaskGroups({ type: "create" });
          if (!created.ok) throw new Error(created.error.message);
          const id = created.value.groups.at(-1)?.id;
          if (!id) throw new Error("Missing group");
          groups.push({ id, title });
          const renamed = await window.zpi.updateTaskGroups({ type: "rename", id, title });
          if (!renamed.ok) throw new Error(renamed.error.message);
          for (const task of tasks.slice(offset, offset + count)) {
            const moved = await window.zpi.updateTaskGroups({ type: "moveTask", id: task, groupId: id });
            if (!moved.ok) throw new Error(moved.error.message);
          }
          offset += count;
        }
        for (const id of tasks.slice(0, rootCount).reverse()) {
          const moved = await window.zpi.updateTaskGroups({ type: "taskTop", id });
          if (!moved.ok) throw new Error(moved.error.message);
        }
        const preferences = await window.zpi.updatePreferences({ sidebarWidth: 338, fontSize: 14 });
        if (!preferences.ok) throw new Error(preferences.error.message);
        localStorage.setItem("zpi.sidebarTaskPreferences", JSON.stringify({ organizeBy: "grouped" }));
        localStorage.setItem(
          "zpi.collapsedTaskGroups",
          JSON.stringify(groups.filter((group) => group.title !== "8.19 迭代").map((group) => group.id)),
        );
        return groups;
      },
      { tasks: ids, rootCount },
    );
    await page.reload();
    await expect(page.locator(".task-group-virtual-list")).toHaveCount(1);
    const offset = (rootCount - 6) * 32;
    const scrollTo = (top: number) =>
      page.locator(".sidebar-sections").evaluate((element, top) => {
        element.scrollTop = top;
      }, top);
    const overlappingHeaders = () =>
      page.locator(".task-groups").evaluate((list) => {
        const scroll = list.closest(".sidebar-sections");
        if (!scroll) throw new Error("Missing scroll container");
        return Array.from(list.querySelectorAll<HTMLElement>(".task-group")).flatMap((group) => {
          const header = group.querySelector(".task-group-header");
          const body = group.querySelector(".task-group-body-grid");
          if (!header || !body) throw new Error("Missing group content");
          const groupRect = group.getBoundingClientRect();
          const headerRect = header.getBoundingClientRect();
          const bodyTop = body.getBoundingClientRect().top;
          // An unpinned header must precede its own content, including offscreen overscan rows.
          return groupRect.top >= scroll.getBoundingClientRect().top && headerRect.bottom > bodyTop + 0.5
            ? [{ title: header.ariaLabel, headerBottom: headerRect.bottom, bodyTop }]
            : [];
        });
      });
    const prior = groups.find((group) => group.title === "技术优化");
    if (!prior) throw new Error("Missing preceding group");
    const header = page.getByRole("button", { name: `分组 ${prior.title}`, exact: true });
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      for (const position of [offset, offset - 100, offset - 300, offset]) {
        await scrollTo(position);
        await expect(page.getByRole("button", { name: "分组 8.19 迭代", exact: true })).toBeVisible();
        await expect.poll(overlappingHeaders).toEqual([]);
      }
      await page
        .locator(".sidebar")
        .screenshot({ path: test.info().outputPath(`group-layout-${theme}.png`) });
      for (const expanded of [true, false]) {
        await header.click();
        await expect(header).toHaveAttribute("aria-expanded", String(expanded));
        await expect.poll(overlappingHeaders).toEqual([]);
      }
    }
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("long grouped/root lists virtualize, sticky headers remain usable, and drafts keep their group", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-groups-long-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const ids = Array.from(
    { length: 170 },
    (_, index) => seedHistory(dir, project, 0, { id: `group-task-${index}` }).id,
  );
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await grouped(page);
    const groupId = await page.evaluate(async (tasks) => {
      const created = await window.zpi.updateTaskGroups({ type: "create" });
      if (!created.ok) throw new Error(created.error.message);
      const id = created.value.groups.at(-1)?.id;
      if (!id) throw new Error("missing group");
      await window.zpi.updateTaskGroups({ type: "rename", id, title: "长列表" });
      for (const taskId of tasks.slice(0, 85)) {
        const result = await window.zpi.updateTaskGroups({ type: "moveTask", id: taskId, groupId: id });
        if (!result.ok) throw new Error(result.error.message);
      }
      return id;
    }, ids);
    await page.reload();
    const group = page.locator(`[data-grouped-group-item-id="${groupId}"]`);
    await expect(group.locator(".task-group-count")).toHaveText("85");
    await expect(page.locator(".task-group-virtual-list")).toHaveCount(2);
    expect(await page.locator(".task-groups [data-testid=session-row]").count()).toBeLessThan(85);
    const firstRows = group.getByTestId("session-row");
    await firstRows.first().hover();
    const firstArchive = firstRows.first().getByRole("button", { name: "归档任务", exact: true });
    await firstArchive.hover();
    await expect(page.getByRole("tooltip", { name: "归档任务", exact: true })).toBeVisible();
    const archiveBounds = await firstArchive.boundingBox();
    const nextBounds = await firstRows.nth(1).boundingBox();
    if (!archiveBounds || !nextBounds) throw new Error("missing archive transition bounds");
    await expectNoCornerTooltipDuring(page, async () => {
      for (let index = 0; index < 3; index++) {
        await page.mouse.move(
          archiveBounds.x + archiveBounds.width / 2,
          nextBounds.y + nextBounds.height / 2,
        );
        await page.mouse.move(
          archiveBounds.x + archiveBounds.width / 2,
          archiveBounds.y + archiveBounds.height / 2,
        );
      }
    });
    await firstArchive.hover();
    await expect(page.getByRole("tooltip", { name: "归档任务", exact: true })).toBeVisible();
    await expectNoCornerTooltipDuring(page, () =>
      page.locator(".sidebar-sections").evaluate((element) => {
        element.scrollTop = 800;
      }),
    );
    await expect(group.locator(".task-group-header")).toHaveClass(/task-group-header-sticky/);
    await group.getByRole("button", { name: "新建任务 长列表", exact: true }).click();
    await expect(page.locator(".task-group-content [data-testid=grouped-draft-row]")).toHaveCount(1);
    await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
    await expect(page.locator(".task-group-content [data-testid=grouped-draft-row]")).toHaveCount(1);
    const draft = page.getByTestId("grouped-draft-row");
    await draft.hover();
    await draft.getByRole("button", { name: "关闭新任务", exact: true }).click();
    await expect(page.getByTestId("grouped-draft-row")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("long group names stay beside their color dot and truncate in menus and drag overlays", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-group-long-title-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const seeded = seedHistory(dir, project, 1);
  const title = "这是一个需要单行省略且不挤压计数的长分组名称".repeat(4);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await grouped(page);
    await createGroup(page, title);
    await page.locator(`.task-groups [data-session-id="${seeded.id}"]`).click({ button: "right" });
    await page.getByRole("menuitem", { name: "移动到分组", exact: true }).hover();
    const menuTitle = page.locator(".task-group-move-title");
    await expect(menuTitle).toBeVisible();
    const menuLayout = await menuTitle.evaluate((element) => {
      const dot = element.parentElement?.querySelector(".task-group-color-dot");
      if (!dot) throw new Error("missing group color dot");
      const style = getComputedStyle(element);
      return {
        gap: element.getBoundingClientRect().left - dot.getBoundingClientRect().right,
        overflowing: element.scrollWidth > element.clientWidth,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
      };
    });
    expect(menuLayout).toMatchObject({ overflowing: true, whiteSpace: "nowrap", textOverflow: "ellipsis" });
    expect(menuLayout.gap).toBeGreaterThanOrEqual(7);
    expect(menuLayout.gap).toBeLessThanOrEqual(9);
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    const header = page.getByRole("button", { name: `分组 ${title}`, exact: true });
    const titleBounds = await header.locator(".task-group-title").boundingBox();
    if (!titleBounds) throw new Error("missing group title bounds");
    await page.mouse.move(titleBounds.x + 8, titleBounds.y + titleBounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(titleBounds.x + 8, titleBounds.y + titleBounds.height / 2 + 12, { steps: 3 });
    const overlay = page.locator(".task-group-drag-overlay.task-group-header");
    await expect(overlay).toBeVisible();
    const overlayLayout = await overlay.evaluate((element) => {
      const name = element.querySelector<HTMLElement>(".task-group-overlay-title");
      const count = element.querySelector<HTMLElement>(".task-group-count");
      if (!name || !count) throw new Error("missing group overlay content");
      const style = getComputedStyle(name);
      const bounds = element.getBoundingClientRect();
      return {
        overflowing: name.scrollWidth > name.clientWidth,
        whiteSpace: style.whiteSpace,
        textOverflow: style.textOverflow,
        countFits: count.getBoundingClientRect().right <= bounds.right,
        height: bounds.height,
      };
    });
    expect(overlayLayout).toEqual({
      overflowing: true,
      whiteSpace: "nowrap",
      textOverflow: "ellipsis",
      countFits: true,
      height: 32,
    });
    await page.keyboard.press("Escape");
    await page.mouse.up();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("grouped view shares pinned shortcuts and creates group drafts through Cmd/Ctrl+N; bracket panes and search hints stay synchronized", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-group-shortcuts-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const first = seedHistory(dir, cwd, 1).id,
    second = seedHistory(dir, cwd, 1).id,
    groupedTask = seedHistory(dir, cwd, 1).id;
  const primary = process.platform === "darwin" ? "Meta" : "Control";
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await grouped(page);
    const groupId = await page.evaluate(
      async ({ first, second, groupedTask }) => {
        const result = await window.zpi.updateTaskGroups({ type: "create" });
        if (!result.ok) throw new Error(result.error.message);
        const groupId = result.value.groups[0].id;
        for (const id of [first, second, groupedTask])
          await window.zpi.updateTaskGroups({ type: "moveTask", id, groupId });
        await window.zpi.setSessionPinned(second, true);
        await window.zpi.setSessionPinned(first, true);
        return groupId;
      },
      { first, second, groupedTask },
    );
    await page.reload();
    const pinned = page.locator(".pinned-tasks [data-session-id]");
    await expect(pinned.first()).toHaveAttribute("data-session-id", second);
    await page.keyboard.press(`${primary}+1`);
    await expect(pinned.first()).toHaveClass(/active/);
    await page.keyboard.press(`${primary}+2`);
    await expect(pinned.last()).toHaveClass(/active/);
    await page.locator(`.task-groups [data-session-id="${groupedTask}"]`).click();
    const group = page.locator(`[data-grouped-group-item-id="${groupId}"]`);
    const header = group.locator(".task-group-header");
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${primary}+n`);
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(group.getByTestId("grouped-draft-row")).toBeVisible();
    await expect(
      page.locator(`[data-grouped-group-item-id="${groupId}"] [data-testid=grouped-draft-row]`),
    ).toHaveCount(1);
    const draftId = await page.evaluate(() => localStorage.getItem("zpi.selectedSession"));
    await header.click();
    await expect(header).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${primary}+n`);
    await expect(header).toHaveAttribute("aria-expanded", "true");
    await expect(group.getByTestId("grouped-draft-row")).toBeVisible();
    expect(await page.evaluate(() => localStorage.getItem("zpi.selectedSession"))).toBe(draftId);
    await expect
      .poll(async () => {
        const result = await page.evaluate(() => window.zpi.listRecentSessions());
        if (!result.ok) throw new Error(result.error.message);
        return result.value.filter((record) => record.draft && !record.parentSessionId).length;
      })
      .toBe(1);
    await expect(
      page.locator(`[data-grouped-group-item-id="${groupId}"] [data-testid=grouped-draft-row]`),
    ).toHaveCount(1);
    await page.keyboard.press(`${primary}+[`);
    await expect(page.getByTestId("left-sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${primary}+[`);
    await expect(page.getByTestId("left-sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press(`${primary}+]`);
    await expect(page.getByTestId("right-sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press(`${primary}+]`);
    await expect(page.getByTestId("right-sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("sidebar-search-open").hover();
    await expect(page.getByRole("tooltip")).toContainText(process.platform === "darwin" ? "⌘K" : "Ctrl+K");
    await page.keyboard.press(`${primary}+k`);
    await expect(page.getByRole("dialog")).toBeVisible();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("grouped task menu reuses header actions, icons and pin behavior", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-menu-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const task = seedHistory(dir, project, 1);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await grouped(page);
    const row = page.locator(`[data-testid="session-row"][data-session-id="${task.id}"]`);
    await row.click();
    await page.getByRole("button", { name: "任务菜单", exact: true }).click();
    const header = await page.locator(".task-menu [role=menuitem]").allTextContents();
    await page.keyboard.press("Escape");
    await row.click({ button: "right" });
    const menu = page.locator(".grouped-task-context-menu");
    await expect(menu.locator("[role=menuitem]")).toHaveText(["移动到分组", "移动到顶部", ...header]);
    await expect(menu.getByRole("menuitem", { name: "移动到分组", exact: true }).locator("svg")).toHaveCount(
      2,
    );
    await expect(menu.getByRole("menuitem", { name: "移动到顶部", exact: true }).locator("svg")).toHaveCount(
      1,
    );
    await expect(menu.getByText("标记未读", { exact: true })).toHaveCount(0);
    await menu.getByRole("menuitem", { name: "置顶", exact: true }).click();
    await expect(page.locator(`.pinned-tasks [data-session-id="${task.id}"]`)).toBeVisible();
    await page.reload();
    const pinned = page.locator(`.pinned-tasks [data-session-id="${task.id}"]`);
    await pinned.hover();
    await pinned.getByRole("button", { name: /^取消置顶任务 / }).click();
    await expect(page.locator(`.pinned-tasks [data-session-id="${task.id}"]`)).toHaveCount(0);
    await row.click({ button: "right" });
    await menu.getByRole("menuitem", { name: "重命名任务", exact: true }).click();
    const input = page.getByRole("textbox", { name: "重命名任务", exact: true });
    await expect(input).toBeFocused();
    await input.fill("菜单重命名");
    await input.press("Enter");
    await expect(row).toContainText("菜单重命名");
    await page.reload();
    await expect(row).toContainText("菜单重命名");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("task drag retains the final preview through delayed saves, group crossings and direction reversal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-group-drag-save-"));
  const project = join(dir, "project");
  await mkdir(project);
  for (const [index, id] of ["a", "b", "c", "d"].entries())
    seedHistory(dir, project, 0, { id, createdAt: Date.now() - index * 1000 });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await grouped(page);
    await createGroup(page, "甲");
    await createGroup(page, "乙");
    const { g, h } = await page.evaluate(async () => {
      const result = await window.zpi.getTaskGroups();
      if (!result.ok) throw new Error(result.error.message);
      const g = result.value.groups.find((group) => group.title === "甲")?.id;
      const h = result.value.groups.find((group) => group.title === "乙")?.id;
      if (!g || !h) throw new Error("Missing groups");
      for (const [id, groupId] of [
        ["a", g],
        ["b", g],
        ["d", h],
      ]) {
        const moved = await window.zpi.updateTaskGroups({ type: "moveTask", id, groupId });
        if (!moved.ok) throw new Error(moved.error.message);
      }
      await window.zpi.updateTaskGroups({
        type: "moveGroup",
        id: g,
        target: { type: "group", id: h },
        position: "before",
      });
      return { g, h };
    });
    await page.reload();
    await grouped(page);
    await app.evaluate(({ ipcMain }) => {
      const original = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> }
      )._invokeHandlers.get("zpi:call");
      if (!original) throw new Error("Missing IPC handler");
      const pending: (() => void)[] = [];
      (globalThis as unknown as { taskGroupSave: { pending: (() => void)[] } }).taskGroupSave = { pending };
      ipcMain.removeHandler("zpi:call");
      ipcMain.handle("zpi:call", async (event, method, args) => {
        if (method === "updateTaskGroups") await new Promise<void>((resolve) => pending.push(resolve));
        return original(event, method, args);
      });
    });
    const section = (id: string) => page.locator(`[data-grouped-group-item-id="${id}"]`);
    const order = (id: string) =>
      section(id)
        .locator(".task-group-content [data-testid=session-row]")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-session-id")));
    const taskRow = (id: string) =>
      page.locator(`.task-groups [data-testid=session-row][data-session-id="${id}"]`);
    const moveTo = async (id: string) => {
      const box = await taskRow(id).boundingBox();
      if (!box) throw new Error("Missing task bounds");
      await page.mouse.move(box.x + 40, box.y + box.height / 2, { steps: 12 });
    };
    const pending = () =>
      app?.evaluate(
        () =>
          (globalThis as unknown as { taskGroupSave: { pending: unknown[] } }).taskGroupSave.pending.length,
      );
    const release = () =>
      app?.evaluate(() =>
        (
          globalThis as unknown as { taskGroupSave: { pending: (() => void)[] } }
        ).taskGroupSave.pending.shift()?.(),
      );
    const saved = () =>
      page.evaluate(async () => {
        const result = await window.zpi.getTaskGroups();
        if (!result.ok) throw new Error(result.error.message);
        return result.value.members;
      });
    await expect.poll(() => order(g)).toEqual(["a", "b"]);
    await moveTo("b");
    await page.mouse.down();
    await moveTo("a");
    await expect.poll(() => order(g)).toEqual(["b", "a"]);
    await page.mouse.up();
    await expect.poll(pending).toBe(1);
    expect((await saved())[g]).toEqual(["a", "b"]);
    await expect.poll(() => order(g)).toEqual(["b", "a"]);
    await release();
    await expect.poll(async () => (await saved())[g]).toEqual(["b", "a"]);
    await moveTo("a");
    await page.mouse.down();
    await moveTo("d");
    await expect.poll(() => order(h)).toEqual(["d", "a"]);
    await moveTo("d");
    await expect.poll(() => order(h)).toEqual(["a", "d"]);
    await page.mouse.up();
    await expect.poll(pending).toBe(1);
    await expect.poll(() => order(h)).toEqual(["a", "d"]);
    expect((await saved())[h]).toEqual(["d"]);
    await release();
    await expect.poll(async () => (await saved())[h]).toEqual(["a", "d"]);
    await page.reload();
    await grouped(page);
    await expect.poll(() => order(g)).toEqual(["b"]);
    await expect.poll(() => order(h)).toEqual(["a", "d"]);
    await moveTo("d");
    await page.mouse.down();
    await moveTo("b");
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect.poll(() => order(h)).toEqual(["a", "d"]);
    expect(await pending()).toBe(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
