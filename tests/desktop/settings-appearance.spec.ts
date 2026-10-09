import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";
import { expectZCodeSystemFont } from "../helpers/rendered-fonts.ts";
import { seedHistory } from "../history-fixture.ts";

test("settings replace the workspace on the first frame without changing its layout or state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-settings-first-frame-"));
  const session = seedHistory(dir, dir, 1);
  const app = await launchDesktop({ dir, url: "" });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.locator(`[data-session-id="${session.id}"] .session-name`).click();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.locator(".right-pane")).toHaveCSS("opacity", "1");
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const firstFrame = await page.evaluate(async () => {
        const panels = [".sidebar", ".main", ".right-pane"].map((selector) => {
          const node = document.querySelector<HTMLElement>(selector);
          if (!node) throw Error(`Missing ${selector}`);
          return node;
        });
        const before = panels.map((node) => node.getBoundingClientRect().toJSON());
        const button = document.querySelector<HTMLButtonElement>(".sidebar-footer button");
        if (!button) throw Error("Missing settings button");
        button.click();
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        return {
          settingsPresent: Boolean(document.querySelector(".settings-screen")),
          before,
          after: panels.map((node) => node.getBoundingClientRect().toJSON()),
          panels: panels.map((node) => {
            let painted = true;
            for (let parent: HTMLElement | null = node; parent; parent = parent.parentElement) {
              const style = getComputedStyle(parent);
              if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)
                painted = false;
            }
            return { painted, inert: Boolean(node.closest("[inert]")) };
          }),
        };
      });
      expect(firstFrame.settingsPresent).toBe(true);
      expect(firstFrame.panels).toEqual(Array(3).fill({ painted: false, inert: true }));
      expect(firstFrame.after).toEqual(firstFrame.before);
      await page.screenshot({ path: `test-results/settings-first-frame-${theme}.png` });
      await page.locator(".mention-editor").evaluate((node: HTMLElement) => node.focus());
      await expect(page.getByLabel("关闭设置", { exact: true })).toBeFocused();
      await page.getByLabel("关闭设置", { exact: true }).click();
      await expect(page.locator(".topbar-title")).toHaveText("历史标题");
      await expect(page.locator(".right-pane")).toBeVisible();
      await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const timeline of [false, true]) {
  test(`settings preserve ${timeline ? "timeline" : "project"} task pagination and scroll while closing hints`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ZPI-settings-sidebar-state-"));
    for (let index = 0; index < 25; index++) seedHistory(dir, dir, 1);
    const app = await launchDesktop({ dir, url: "" });
    try {
      const page = await app.firstWindow();
      if (timeline) {
        await page.getByLabel("筛选和排序", { exact: true }).click();
        await page.getByRole("menuitemradio", { name: "时间线", exact: true }).click();
        await expect(page.getByRole("menu")).toHaveCount(0);
        await expect(page.getByLabel("筛选和排序", { exact: true })).toBeFocused();
      }
      const list = page.locator(timeline ? ".timeline-tasks" : ".recent-sessions");
      await expect(list.getByTestId("session-row")).toHaveCount(20);
      await list.getByRole("button", { name: "显示更多", exact: true }).click();
      await expect(list.getByTestId("session-row")).toHaveCount(25);
      const settingsButton = page.getByRole("button", { name: "设置", exact: true });
      await settingsButton.focus();
      const scroll = await page.locator(".sidebar-sections").evaluate((element) => {
        element.scrollTop = 200;
        return element.scrollTop;
      });
      expect(scroll).toBeGreaterThan(0);
      const hint = page.getByRole("tooltip").filter({ hasText: /^设置$/ });
      for (let attempt = 0; attempt < 2; attempt++) {
        await settingsButton.hover();
        await expect(hint).toBeVisible();
        await settingsButton.click();
        const settings = page.getByRole("region", { name: "设置", exact: true });
        await expect(settings).toBeVisible();
        await expect(hint).toHaveCount(0);
        await settings.getByLabel("关闭设置").click();
        await expect(list.getByTestId("session-row")).toHaveCount(25);
        await expect
          .poll(() => page.locator(".sidebar-sections").evaluate((element) => element.scrollTop))
          .toBe(scroll);
      }
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("settings hide pinned task controls and restore the task sidebar on return", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-settings-pinned-"));
  const session = seedHistory(dir, dir, 1);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const row = page.locator(`.sidebar [data-session-id="${session.id}"]`);
    await row.hover();
    await row.getByLabel("置顶任务 历史标题", { exact: true }).click();
    const pin = row.getByLabel("取消置顶任务 历史标题", { exact: true });
    await expect(pin).toBeVisible();
    await row.getByRole("button", { name: "历史标题", exact: true }).click();
    await expect(page.locator(".topbar-title")).toHaveText("历史标题");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    for (const name of ["常规", "界面设置", "系统提示词", "工具", "技能", "模型", "已归档任务"]) {
      const tab = settings.getByRole("button", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: "取消置顶任务 历史标题", exact: true })).toHaveCount(0);
      await expect(page.locator(".workspace-surface")).toHaveCSS("opacity", "0");
      await expect(page.locator(".workspace-surface")).toHaveAttribute("inert", "");
      await expect(pin).toHaveCount(1);
    }
    await settings.getByLabel("关闭设置").click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator(".topbar-title")).toHaveText("历史标题");
    await expect(page.locator(".sidebar-resizer")).toBeVisible();
    await expect(pin).toBeVisible();
    await pin.click();
    await expect(page.locator(".pinned-tasks")).toHaveCount(0);
    await row.hover();
    await expect(row.getByLabel("置顶任务 历史标题", { exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("settings use ZCode typography and keep titlebar dragging separate from controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-settings-appearance-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    const tab = settings.getByRole("button", { name: "系统提示词", exact: true });
    const title = settings.locator("h1");
    const heading = settings.locator(".interface-settings h2").first();
    const label = settings.locator(".settings-row-copy strong").first();
    const description = settings.locator(".settings-row-copy small").first();
    await expectZCodeSystemFont(page, [
      ".settings-back",
      ".settings-tabs button",
      ".settings-content h1",
      ".interface-settings h2",
      ".settings-row-copy strong",
      ".settings-row-copy small",
      ".settings-select-trigger .settings-select-value",
    ]);
    await expect(tab.locator("svg")).toHaveCSS("width", "16px");
    await expect(settings.locator(".settings-back svg")).toHaveCSS("width", "16px");
    for (const icon of await settings.locator("svg.lucide").all()) {
      await expect(icon).toHaveCSS("stroke-width", "1.5px");
    }
    for (const name of ["常规", "系统提示词", "工具", "技能", "模型", "已归档任务"]) {
      await settings.getByRole("button", { name, exact: true }).click();
      await expectZCodeSystemFont(page, [".settings-content h1"]);
    }
    await settings.getByRole("button", { name: "界面设置", exact: true }).click();

    // Reference: ZCode SettingsPage, SettingsRow and theme-zai-light/theme-zai-dark.
    for (const [theme, color] of [
      ["浅色", /oklch\(0\.269 0 (?:0|none)\)/],
      ["深色", /oklch\(0\.87 0 (?:0|none)\)/],
    ] as const) {
      await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
      for (const icon of await page.locator(".settings-select-menu svg.lucide").all()) {
        await expect(icon).toHaveCSS("stroke-width", "1.5px");
      }
      await page.getByRole("option", { name: theme, exact: true }).click();
      await expect(tab).toHaveCSS("color", color);
      await expect(label).toHaveCSS("color", color);
      await expect(title).toHaveCSS("color", color);
      await expect(tab).toHaveCSS("font-size", "14px");
      await expect(tab).toHaveCSS("font-weight", "400");
      await expect(heading).toHaveCSS("font-size", "16px");
      await expect(heading).toHaveCSS("font-weight", "600");
      await expect(label).toHaveCSS("font-size", "14px");
      await expect(label).toHaveCSS("font-weight", "500");
      await expect(description).toHaveCSS("font-size", "14px");
      await expect(description).toHaveCSS("line-height", "24px");
      expect(await description.evaluate((el) => getComputedStyle(el).color)).toContain("/ 0.6)");
      expect(await label.evaluate((el) => getComputedStyle(el).fontFamily)).toMatch(
        /^ui-sans-serif, system-ui, sans-serif,/,
      );
      await page.screenshot({ path: `test-results/settings-${theme === "浅色" ? "light" : "dark"}.png` });
    }
    await expect(title).toHaveCSS("font-size", "30px");
    await expect(settings.locator(".settings-titlebar")).toHaveCSS("app-region", "drag");
    await expect(settings.locator(".settings-sidebar-drag-space")).toHaveCSS("app-region", "drag");
    await expect(tab).toHaveCSS("app-region", "no-drag");
    await expect(settings.getByLabel("关闭设置")).toHaveCSS("app-region", "no-drag");
    await tab.click();
    await expect(title).toHaveText("系统提示词");
    await settings.getByRole("button", { name: "界面设置", exact: true }).click();

    const initialRow = await settings.locator(".settings-row").first().boundingBox();
    const fontSize = settings.getByRole("spinbutton", { name: "界面字号", exact: true });
    await expect(fontSize).toHaveValue("14");
    await expect(fontSize).toHaveCSS("height", "28px");
    await expect(fontSize).toHaveCSS("border-top-width", "1px");
    await expect(settings.locator(".settings-breadcrumb")).toHaveCount(0);
    await expect(settings.locator(".settings-main")).toHaveCSS("border-radius", "12px");
    await expect(settings.locator(".settings-main")).toHaveCSS("overflow", "hidden");
    for (const size of [16, 12, 15, 20, 14]) {
      await fontSize.fill(String(size));
      await fontSize.press("Enter");
      await expect(label).toHaveCSS("font-size", `${size}px`);
      await expect(description).toHaveCSS("font-size", `${size}px`);
      await expect(page.locator("html")).toHaveCSS("font-size", "16px");
      await expect(settings.locator(".settings-select-trigger").first()).toHaveCSS("height", "32px");
      await expect(title).toHaveCSS("font-size", "30px");
      expect((await settings.locator(".settings-row").first().boundingBox())?.width).toBe(initialRow?.width);
    }
    // ZCode clamps/rounds on commit and restores empty or cancelled edits.
    for (const [input, result] of [
      ["11", "12"],
      ["21", "20"],
      ["15.6", "16"],
      ["", "16"],
    ]) {
      await fontSize.fill(input);
      await fontSize.press("Tab");
      await expect(fontSize).toHaveValue(result);
    }
    await fontSize.fill("18");
    await fontSize.press("Escape");
    await expect(fontSize).toHaveValue("16");
    await expect(settings).toBeVisible();
    await fontSize.fill("15");
    await fontSize.press("Enter");
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(fontSize).toHaveValue("15");
    await expect(tab).toHaveCSS("font-size", "15px");
    await fontSize.fill("14");
    await fontSize.press("Enter");

    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 740));
    await expect(title).toHaveCSS("font-size", "24px");
    await expect(settings.locator(".settings-titlebar")).toHaveCSS("app-region", "drag");
    await settings.getByLabel("关闭设置").click();
    await expect(settings).toHaveCount(0);
    await expect(page.locator(".topbar")).toHaveCSS("font-size", "14px");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
