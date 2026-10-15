import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

async function createGroup(page: Page, title: string) {
  await page.getByRole("button", { name: "新建分组", exact: true }).click();
  const input = page.getByRole("textbox", { name: "重命名分组", exact: true });
  await input.fill(title);
  await input.press("Enter");
  await page.keyboard.press("Escape");
}

test("task switcher matches ZCode theme tokens and keeps group expansion beside the tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-toolbar-"));
  const project = join(dir, "project");
  await mkdir(project);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).click();
    const toolbar = page.locator(".sidebar-task-toolbar");
    await toolbar.getByRole("button", { name: "收起全部", exact: true }).click();
    await toolbar.getByRole("button", { name: "分组", exact: true }).click();
    const tabs = toolbar.locator(".task-primary-tabs");
    const toggle = toolbar.locator(".task-group-toggle:not(.task-group-create)");
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-label", "展开全部");

    for (const theme of ["light", "dark"] as const) {
      await page.evaluate((theme) => window.zpi.updatePreferences({ theme }), theme);
      await page.reload();
      const colors = await page.evaluate(() => {
        const probe = document.createElement("span");
        document.body.append(probe);
        const color = (token: string) => {
          probe.style.color = `var(${token})`;
          return getComputedStyle(probe).color;
        };
        const result = {
          fill: color("--color-fill"),
          background: color("--color-bg"),
          foreground: color("--color-foreground"),
          subtle: color("--color-text-subtle"),
        };
        probe.remove();
        return result;
      });
      await expect(tabs).toHaveCSS("height", "28px");
      await expect(tabs).toHaveCSS("padding", "2px");
      await expect(tabs).toHaveCSS("background-color", colors.fill);
      const active = tabs.locator('[aria-pressed="true"]');
      const inactive = tabs.locator('[aria-pressed="false"]');
      for (const tab of [active, inactive]) {
        await expect(tab).toHaveCSS("height", "24px");
        await expect(tab).toHaveCSS("padding-left", "6px");
        await expect(tab).toHaveCSS("padding-right", "8px");
        await expect(tab).toHaveCSS("column-gap", "4px");
        await expect(tab).toHaveCSS("font-size", "12px");
        await expect(tab).toHaveCSS("font-weight", "500");
        await expect(tab.locator("svg")).toHaveCSS("width", "12px");
        await expect(tab.locator("svg")).toHaveCSS("stroke-width", "1.5px");
      }
      await page.locator(".sidebar-global").hover();
      await expect(inactive).toHaveCSS("color", colors.subtle);
      await expect(active).toHaveCSS("background-color", colors.background);
      await inactive.hover();
      await expect(inactive).toHaveCSS("color", colors.foreground);
      await expect(inactive).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await active.hover();
      await expect(active).toHaveCSS("background-color", colors.background);
      await expect(toggle).toHaveCSS("width", "24px");
      await expect(toggle).toHaveCSS("height", "24px");
      await expect(toggle.locator("svg")).toHaveCSS("width", "14px");
      const tabBounds = await tabs.boundingBox();
      const toggleBounds = await toggle.boundingBox();
      if (!tabBounds || !toggleBounds) throw new Error("Missing task toolbar bounds");
      expect(toggleBounds.x - tabBounds.x - tabBounds.width).toBeCloseTo(4, 1);
    }

    await createGroup(page, "First");
    await createGroup(page, "Second");
    const headers = page.locator(".task-group-header[data-grouped-group-header-id]");
    await expect(headers).toHaveCount(2);
    await expect(toggle).toBeEnabled();
    await expect(toggle).toHaveAttribute("aria-label", "收起全部");
    await toggle.hover();
    await expect(page.getByRole("tooltip")).toHaveText("收起全部");
    for (let repeat = 0; repeat < 2; repeat++) {
      await toggle.click();
      await expect(headers.nth(0)).toHaveAttribute("aria-expanded", "false");
      await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "false");
      await expect(toggle).toHaveAttribute("aria-label", "展开全部");
      await toggle.click();
      await expect(headers.nth(0)).toHaveAttribute("aria-expanded", "true");
      await expect(headers.nth(1)).toHaveAttribute("aria-expanded", "true");
      await expect(toggle).toHaveAttribute("aria-label", "收起全部");
    }
    await headers.first().click();
    await expect(toggle).toHaveAttribute("aria-label", "展开全部");
    await toolbar.getByRole("button", { name: "项目", exact: true }).click();
    await expect(toggle).toHaveAttribute("aria-label", "展开全部");
    await toggle.click();
    await toolbar.getByRole("button", { name: "分组", exact: true }).click();
    await expect(headers.first()).toHaveAttribute("aria-expanded", "false");
    await expect(headers.last()).toHaveAttribute("aria-expanded", "true");
    await page.reload();
    await expect(toggle).toHaveAttribute("aria-label", "展开全部");
    await toggle.click();
    await expect(headers.first()).toHaveAttribute("aria-expanded", "true");
    for (const remaining of [1, 0]) {
      await headers.first().click({ button: "right" });
      await page.getByRole("menuitem", { name: "取消分组并删除", exact: true }).click();
      await expect(headers).toHaveCount(remaining);
    }
    await expect(toggle).toBeVisible();
    await expect(toggle).toBeDisabled();
    await expect(toggle).toHaveAttribute("aria-label", "展开全部");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
