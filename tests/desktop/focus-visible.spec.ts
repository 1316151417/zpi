import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

const focusStyle = (locator: Locator) =>
  locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      visible: element.matches(":focus-visible"),
      style: style.outlineStyle,
      width: style.outlineWidth,
      color: style.outlineColor,
    };
  });

test("buttons, switches and fields use their own keyboard focus cues in both themes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-focus-visible-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const ring = {
        visible: true,
        style: "solid",
        width: "1px",
        color: theme === "light" ? "rgba(13, 13, 13, 0.15)" : "rgba(255, 255, 255, 0.15)",
      };
      const search = page.getByTestId("sidebar-search-open");
      await expect(search).toBeVisible();
      const sidebarBounds = await search.boundingBox();
      // Establish keyboard modality before focusing a particular real control.
      await page.keyboard.press("Tab");
      await search.focus();
      await expect.poll(() => focusStyle(search)).toEqual(ring);
      expect(await search.boundingBox()).toEqual(sidebarBounds);

      await search.click();
      const searchDialog = page.getByRole("dialog", { name: "搜索任务", exact: true });
      const searchInput = searchDialog.getByRole("combobox");
      await expect(searchInput).toBeFocused();
      await searchInput.fill("yewen");
      expect(await focusStyle(searchInput)).toMatchObject({ style: "none", width: "0px" });
      await expect(searchInput).toHaveCSS("border-top-width", "0px");
      await expect(searchInput).toHaveCSS("box-shadow", "none");
      await page.keyboard.press("Tab");
      await searchInput.focus();
      expect(await focusStyle(searchInput)).toMatchObject({ style: "none", width: "0px" });
      await searchDialog.screenshot({ path: `test-results/search-focus-${theme}.png` });
      await searchInput.press("Escape");
      await expect(searchDialog).toHaveCount(0);

      await page.getByRole("button", { name: "设置", exact: true }).click();
      const appearance = page.getByRole("button", { name: "界面设置", exact: true });
      await appearance.click();
      await expect(appearance).toBeFocused();
      expect(await focusStyle(appearance)).toMatchObject({ visible: false, style: "none" });
      const tabBounds = await appearance.boundingBox();
      await page.keyboard.press("Tab");
      const shortcuts = page.getByRole("button", { name: "快捷键", exact: true });
      await expect(shortcuts).toBeFocused();
      await expect.poll(() => focusStyle(shortcuts)).toEqual(ring);
      await page.keyboard.press("Shift+Tab");
      await expect(appearance).toBeFocused();
      await expect.poll(() => focusStyle(appearance)).toEqual(ring);
      expect(await appearance.boundingBox()).toEqual(tabBounds);

      const size = page.getByRole("spinbutton", { name: "界面字号", exact: true });
      const inputBounds = await size.boundingBox();
      await size.focus();
      expect(await focusStyle(size)).toMatchObject({ style: "none", width: "0px" });
      await expect(size).toHaveCSS("border-top-color", ring.color);
      expect(await size.boundingBox()).toEqual(inputBounds);

      const themeSelect = page.getByRole("combobox", { name: "界面主题", exact: true });
      const selectBorder = await themeSelect.evaluate((element) => getComputedStyle(element).borderTopColor);
      await themeSelect.focus();
      expect(await focusStyle(themeSelect)).toMatchObject({ visible: true, style: "none" });
      await expect(themeSelect).not.toHaveCSS("border-top-color", selectBorder);
      await themeSelect.press("Space");
      const option = page.getByRole("option", { name: "系统", exact: true });
      await expect(option).toBeFocused();
      expect(await focusStyle(option)).toMatchObject({ visible: true, style: "none" });
      await expect(option).toHaveCSS(
        "background-color",
        theme === "light" ? "rgba(13, 13, 13, 0.05)" : "rgba(255, 255, 255, 0.1)",
      );
      await option.press("ArrowDown");
      await expect(page.getByRole("option", { name: "深色", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");

      const lineNumbers = page.getByRole("checkbox", { name: "显示行号", exact: true });
      const switchTrack = lineNumbers.locator("+ span");
      await lineNumbers.scrollIntoViewIfNeeded();
      const switchBounds = await switchTrack.boundingBox();
      await lineNumbers.focus();
      await expect(switchTrack).toHaveCSS("outline-style", "solid");
      await expect(switchTrack).toHaveCSS("outline-width", "1px");
      await expect(switchTrack).toHaveCSS("outline-color", ring.color);
      expect(await switchTrack.boundingBox()).toEqual(switchBounds);
      await appearance.click();
      await lineNumbers.click();
      await expect(switchTrack).toHaveCSS("outline-style", "none");
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();

      const editor = page.getByLabel("消息", { exact: true });
      const composer = page.locator(".composer").filter({ has: editor });
      const composerBounds = await composer.boundingBox();
      await editor.click();
      await expect(editor).toBeFocused();
      expect(await focusStyle(editor)).toMatchObject({ style: "none", width: "0px" });
      await page.keyboard.press("Tab");
      await editor.focus();
      expect(await focusStyle(editor)).toMatchObject({ style: "none", width: "0px" });
      expect(await composer.boundingBox()).toEqual(composerBounds);
      await composer.screenshot({ path: `test-results/composer-focus-${theme}.png` });
    }
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("Shift and arrow navigation keep model menu focus on the row background without an extra ring", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-menu-focus-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const result = await window.zpi.saveProvider({
        id: "focus-fixture",
        name: "焦点测试",
        baseUrl: "http://127.0.0.1:1/v1",
        apiKey: "",
        models: [
          { id: "focus-first", reasoning: true },
          { id: "focus-second", reasoning: true },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
    });
    await page.reload();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      const background = theme === "light" ? "rgba(13, 13, 13, 0.05)" : "rgb(54, 54, 54)";
      await page.getByLabel("模型选择", { exact: true }).click();
      const first = page.getByRole("menuitem", { name: "focus-first", exact: true });
      await first.hover();
      await expect(first).toBeFocused();
      expect(await focusStyle(first)).toMatchObject({ style: "none", width: "0px" });
      await page.keyboard.press("Shift");
      expect(await focusStyle(first)).toMatchObject({ visible: true, style: "none", width: "0px" });
      await expect(first).toHaveCSS("background-color", background);

      // Leave hover-driven submenus before switching to keyboard navigation.
      await page.mouse.move(0, 0);
      await first.press("ArrowDown");
      const second = page.getByRole("menuitem", { name: "focus-second", exact: true });
      await expect(second).toBeFocused();
      expect(await focusStyle(second)).toMatchObject({ visible: true, style: "none" });
      await expect(second).toHaveCSS("background-color", background);
      await second.press("ArrowRight");
      const reasoning = page.locator(".reasoning-menu [role=menuitem]");
      await expect(reasoning.first()).toBeFocused();
      expect(await focusStyle(reasoning.first())).toMatchObject({ visible: true, style: "none" });
      await expect(reasoning.first()).toHaveCSS("background-color", background);
      await page.keyboard.press("ArrowDown");
      await expect(reasoning.nth(1)).toBeFocused();
      await expect(reasoning.nth(1)).toHaveCSS("background-color", background);
      await page.screenshot({ path: `test-results/model-menu-focus-${theme}.png` });
      await page.keyboard.press("ArrowLeft");
      await expect(second).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect(page.getByLabel("消息", { exact: true })).toBeFocused();
    }
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("file selection uses a background while keyboard focus uses the row border in both themes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-file-focus-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "selected.md"), "# Selected file\n");
  await writeFile(join(project, "focused.md"), "# Focused file\n");
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).click();
    await expect(page.getByLabel("选择项目", { exact: true })).toContainText("project");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    const pane = page.locator(".right-pane");
    await pane.locator(".pane-empty-launcher").getByRole("button", { name: "文件", exact: true }).click();
    const selected = pane.getByRole("treeitem").filter({ hasText: "selected.md" });
    const focused = pane.getByRole("treeitem").filter({ hasText: "focused.md" });
    await selected.click();
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await page.keyboard.press("Shift");
      await focused.focus();
      await expect(focused).toBeFocused();
      await expect(focused).toHaveAttribute("aria-selected", "false");
      await expect(focused).toHaveCSS("outline-style", "none");
      await expect(focused).toHaveCSS(
        "border-top-color",
        theme === "light" ? "rgba(13, 13, 13, 0.15)" : "rgba(255, 255, 255, 0.15)",
      );
      await expect(selected).toHaveAttribute("aria-selected", "true");
      await expect(selected).toHaveCSS("border-top-color", "rgba(0, 0, 0, 0)");
      await expect(selected).toHaveCSS(
        "background-color",
        theme === "light" ? "rgba(13, 13, 13, 0.05)" : "rgba(255, 255, 255, 0.1)",
      );
      await pane.screenshot({ path: `test-results/file-focus-${theme}.png` });
    }
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
