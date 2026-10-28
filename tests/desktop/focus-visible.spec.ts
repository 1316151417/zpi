import { mkdtemp, rm } from "node:fs/promises";
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

test("keyboard focus stays subtle and input controls avoid an extra inner ring in both themes", async () => {
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
      expect(await size.boundingBox()).toEqual(inputBounds);
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
