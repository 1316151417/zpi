import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

async function view(page: Page, name: string) {
  await expect(page.getByRole("menu")).toHaveCount(0);
  await page.evaluate(
    () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
  );
  await page.getByTestId("sidebar-view-menu").click();
  await expect(page.getByTestId("sidebar-view-menu")).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("menu").hover();
  await page.getByRole("menuitemradio", { name, exact: true }).click();
  await expect(page.getByRole("menu")).toHaveCount(0);
}
async function createGroup(page: Page, title: string) {
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  const input = page.getByRole("textbox", { name: "重命名分组", exact: true });
  await input.fill(title);
  await input.press("Enter");
  await page.keyboard.press("Escape");
}

test("ZCode list header keeps search and the three-choice view menu outside scrolling, across themes and widths", async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-toolbar-"));
  const project = join(dir, "project");
  await mkdir(project);
  for (let i = 0; i < 24; i++)
    seedHistory(dir, project, 0, {
      id: `task-${i}`,
      createdAt: Date.now() - i * 1000,
      updatedAt: Date.now() - i * 1000,
    });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    const header = page.getByTestId("sidebar-search-toolbar");
    await expect(page.getByTestId("sidebar-list-title")).toHaveText("任务列表");
    await expect(
      page.locator(".sidebar-global").getByRole("button", { name: "搜索", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator(".task-primary-tabs")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "搜索", exact: true })).toHaveCount(1);
    await page.getByTestId("sidebar-search-open").click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("sidebar-search-open")).toBeFocused();
    for (const theme of ["light", "dark"] as const) {
      for (const sidebarWidth of [200, 280, 360]) {
        await page.evaluate(
          ({ theme, sidebarWidth }) => window.zpi.updatePreferences({ theme, sidebarWidth }),
          { theme, sidebarWidth },
        );
        await page.reload();
        await view(page, "最近更新");
        await expect(page.locator(".timeline-tasks .session-row")).toHaveCount(20);
        const before = await header.boundingBox();
        await page
          .locator(".sidebar-sections")
          .evaluate((element) => (element.scrollTop = element.scrollHeight));
        expect(await header.boundingBox()).toEqual(before);
        await expect(page.getByTestId("sidebar-view-menu")).toHaveAttribute("aria-expanded", "false");
        await page.getByTestId("sidebar-view-menu").click();
        const options = page.getByRole("menuitemradio");
        await expect(options).toHaveText(["按项目", "按分组", "最近更新"]);
        await expect(options.last()).toBeChecked();
        const bounds = await options.first().boundingBox();
        expect(bounds?.width).toBeGreaterThan(100);
        await page.screenshot({
          path: test.info().outputPath(`task-list-menu-${theme}-${sidebarWidth}.png`),
        });
        await options.first().click();
        await page.reload();
        await page.getByTestId("sidebar-view-menu").click();
        await expect(page.getByRole("menuitemradio", { name: "按项目", exact: true })).toBeChecked();
        await page.keyboard.press("Escape");
        await expect(page.getByRole("menu")).toHaveCount(0);
      }
    }
    await view(page, "按分组");
    const toggle = header.getByRole("button", { name: "展开全部", exact: true });
    await expect(toggle).toBeDisabled();
    await createGroup(page, "First");
    await createGroup(page, "Second");
    const headers = page.locator(".task-group-header[data-grouped-group-header-id]");
    await expect(headers).toHaveCount(2);
    await header.getByRole("button", { name: "收起全部", exact: true }).click();
    await expect(headers.first()).toHaveAttribute("aria-expanded", "false");
    await view(page, "按项目");
    await view(page, "按分组");
    await expect(headers.first()).toHaveAttribute("aria-expanded", "false");
    await page.reload();
    await expect(header.getByRole("button", { name: "展开全部", exact: true })).toBeEnabled();
    await header.getByRole("button", { name: "展开全部", exact: true }).click();
    await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
    const order = await header
      .locator("button")
      .evaluateAll((buttons) => buttons.map((button) => button.ariaLabel));
    expect(order).toEqual(["收起全部", "新建分组", "搜索", "筛选视图"]);
    await page.evaluate(() => window.zpi.updatePreferences({ sidebarWidth: 200, fontSize: 20 }));
    await page.reload();
    await expect
      .poll(() =>
        header.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll("button")].every((button) => {
            const rect = button.getBoundingClientRect();
            return rect.width === 24 && rect.left >= bounds.left && rect.right <= bounds.right;
          });
        }),
      )
      .toBe(true);
    await page.screenshot({ path: test.info().outputPath("task-list-grouped-narrow.png") });
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
