import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("A/B background runs, sidebar indicators and hover pin; stop, reload and unread restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  const releaseB = deferred();
  let app: ElectronApplication | undefined;
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const user = messages.find((m) => m.role === "user")?.content;
    send(response, chunk({ content: `${user} first` }));
    if (user === "B") {
      await releaseB.promise;
      send(response, chunk({ content: " second" }));
      done(response);
    }
  });
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("A");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.locator(".answer")).toContainText("A first");
    await page.locator(".project-title").hover();
    await page.getByRole("button", { name: "新建任务 project", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).fill("B");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.locator(".answer")).toContainText("B first");
    await expect(
      page
        .locator(".projects")
        .getByTestId("session-row")
        .filter({ has: page.getByRole("button", { name: "A", exact: true }) }),
    ).toHaveAttribute("data-status", "running");
    const rowA = page.locator('.sidebar [data-testid="session-row"]').filter({
      has: page.getByRole("button", { name: "A", exact: true }),
    });
    const leadingA = rowA.locator(".task-indicator");
    await page.getByLabel("消息", { exact: true }).click();
    await expect(leadingA).toHaveCSS("opacity", "1");
    await expect(rowA.locator(".task-running-icon")).toHaveCSS("animation-duration", "1s");
    await expect(rowA.locator(".task-running-icon")).toHaveCSS("animation-iteration-count", "infinite");
    await expect(rowA.locator(".task-leading-slot")).toHaveCSS("width", "16px");
    const titleX = (await rowA.locator(".session-name").boundingBox())?.x;
    await rowA.hover();
    await expect(leadingA).toHaveCSS("opacity", "0");
    await expect(rowA.getByLabel("置顶任务 A", { exact: true })).toHaveCSS("opacity", "1");
    expect((await rowA.locator(".session-name").boundingBox())?.x).toBe(titleX);
    await rowA.getByLabel("置顶任务 A", { exact: true }).click();
    await expect(page.locator(".pinned-tasks").getByRole("button", { name: "A", exact: true })).toBeVisible();
    await page.getByLabel("消息", { exact: true }).hover();
    await expect(leadingA).toHaveCSS("opacity", "1");
    await expect(rowA.getByLabel("取消置顶任务 A", { exact: true })).toHaveCSS("opacity", "0");
    await expect(page.locator('.projects [data-loading-indicator="true"]')).toHaveCount(1);
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(0);
    await expect(rowA).toHaveCount(1);
    await expect(page.locator('.pinned-tasks [data-loading-indicator="true"]')).toHaveCount(1);
    await page.locator(".sidebar").screenshot({ path: "test-results/sidebar-running.png" });
    await page.locator(".pinned-tasks").getByRole("button", { name: "A", exact: true }).click();
    await page.getByLabel("停止", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "aborted");
    await page.locator(".projects").getByRole("button", { name: "B", exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    await page.reload();
    await expect(page.locator(".answer")).toContainText("B first");
    await expect(page.locator('.projects [data-loading-indicator="true"]')).toHaveCount(1);
    await page.locator(".pinned-tasks").getByRole("button", { name: "A", exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "aborted");
    releaseB.resolve();
    const rowB = () =>
      page.locator('.projects [data-testid="session-row"]').filter({
        has: page.getByRole("button", { name: "B", exact: true }),
      });
    await expect(rowB()).toHaveAttribute("data-status", "completed");
    await expect(rowB().locator('[data-unread-indicator="true"]')).toBeVisible();
    await expect(rowB().locator(".task-unread-dot")).toHaveCSS("width", "6px");
    await expect(page.locator('.projects [data-loading-indicator="true"]')).toHaveCount(0);
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    await expect(rowB().locator('[data-unread-indicator="true"]')).toBeVisible();
    await page.getByLabel("消息", { exact: true }).click();
    await expect(rowB().locator(".task-indicator")).toHaveCSS("opacity", "1");
    await page.locator(".sidebar").screenshot({ path: "test-results/sidebar-unread.png" });
    await rowB().hover();
    await expect(rowB().locator(".task-indicator")).toHaveCSS("opacity", "0");
    await expect(rowB().getByLabel("置顶任务 B", { exact: true })).toHaveCSS("opacity", "1");
    await page.getByLabel("消息", { exact: true }).hover();
    await expect(rowB().locator(".task-indicator")).toHaveCSS("opacity", "1");
    await rowB().getByRole("button", { name: "B", exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".answer")).toContainText("B first second");
    await expect(page.locator('[data-unread-indicator="true"]')).toHaveCount(0);
    await page.reload();
    await expect(page.locator(".answer")).toContainText("B first second");
    await expect(page.locator('[data-unread-indicator="true"]')).toHaveCount(0);
  } finally {
    releaseB.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("draft workspace picker, contextual new tasks and per-project drafts persist until first send", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-draft-project-"));
  const project = join(dir, "工作项目");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, packaged: false, project });
    let page = await app.firstWindow();
    const selectedProject = async () => {
      const result = await page.evaluate(async () => {
        const id = localStorage.getItem("zpi.selectedSession");
        const value = await window.zpi.listRecentSessions();
        return value.ok ? value.value.find((record) => record.id === id)?.projectId : undefined;
      });
      return result;
    };
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("选择项目");
    expect(await selectedProject()).toBeNull();
    await page.getByLabel("消息", { exact: true }).fill("非项目草稿");
    await page.getByLabel("选择项目", { exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "远程连接", exact: true })).toHaveCount(0);
    await page.getByRole("menuitem", { name: "打开文件夹", exact: true }).click();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("工作项目");
    const projectId = await selectedProject();
    expect(projectId).toBeTruthy();
    await page.getByLabel("选择项目", { exact: true }).click();
    await page.screenshot({ path: "test-results/desktop-draft-project-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-draft-project-dark.png" });
    await page.keyboard.press("Escape");
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByLabel("消息", { exact: true }).fill("项目首条消息");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.locator(".answer")).toHaveText("ok");
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveCount(0);
    const editor = () => page.getByLabel("消息", { exact: true });
    await editor().fill("项目第二条消息");
    await editor().press("Enter");
    await expect(page.locator(".answer")).toHaveCount(2);
    await expect(editor()).toHaveText("");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("项目第二条消息");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("项目首条消息");
    await editor().press("ArrowDown");
    await expect(editor()).toHaveText("项目第二条消息");
    await editor().press("ArrowDown");
    await expect(editor()).toHaveText("");
    await editor().press("ArrowUp");
    await editor().press("End");
    await editor().pressSequentially("修改");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("项目第二条消息修改");
    await editor().fill("");
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("工作项目");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("项目第二条消息");
    expect(await selectedProject()).toBe(projectId);
    await page.getByLabel("消息", { exact: true }).fill("项目待发送草稿");
    await page.getByLabel("选择项目", { exact: true }).click();
    await page.getByRole("menuitem", { name: "不在项目中工作", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("非项目草稿");
    expect(await selectedProject()).toBeNull();
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.locator(".answer")).toHaveText("ok");
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("选择项目");
    expect(await selectedProject()).toBeNull();
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("非项目草稿");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("非项目草稿");
    await editor().press("ArrowDown");
    await expect(editor()).toHaveText("");
    await page.getByLabel("选择项目", { exact: true }).click();
    await page.getByLabel("搜索项目", { exact: true }).fill("工作");
    await page.getByRole("menuitem", { name: "工作项目", exact: true }).click();
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("项目待发送草稿");
    await app.close();
    app = await launchDesktop({ dir, url: server.url, packaged: false, project });
    page = await app.firstWindow();
    await expect(page.getByLabel("选择项目", { exact: true })).toHaveText("工作项目");
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("项目待发送草稿");
    expect(await selectedProject()).toBe(projectId);
    await editor().fill("");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("项目第二条消息");
    await editor().press("ArrowUp");
    await expect(editor()).toHaveText("项目首条消息");
    await editor().fill("项目待发送草稿");
    await editor().press("Enter");
    await expect(page.locator(".answer")).toHaveText("ok");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
