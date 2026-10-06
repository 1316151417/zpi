import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("provider menu appears above settings, supports keyboard access and deletes the chosen provider", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-provider-menu-"));
  const app = await launchDesktop({ dir, url: "" });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      for (const [id, name] of [
        ["delete", "菜单测试"],
        ["keep", "保留供应商"],
      ]) {
        const result = await window.ZPI.saveProvider({
          id,
          name,
          baseUrl: "http://127.0.0.1:1/v1",
          apiKey: "",
          models: Array.from({ length: 10 }, (_, i) => ({ id: `model-${i}`, reasoning: false })),
        });
        if (!result.ok) throw new Error(result.error.message);
      }
    });
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.getByRole("button", { name: "菜单测试", exact: true }).click();
    await page.getByRole("button", { name: "供应商操作", exact: true }).click();
    const item = page.getByRole("menuitem", { name: "删除", exact: true });
    await expect(item).toBeVisible();
    expect(
      await item.evaluate((element) => {
        const rect = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
      }),
    ).toBe(true);
    await item.evaluate(async (el) => {
      await Promise.all(
        el
          .closest('[role="menu"]')
          ?.getAnimations()
          .map((animation) => animation.finished) ?? [],
      );
    });
    expect(await page.getByRole("menu").evaluate((el) => el.getBoundingClientRect().width)).toBe(128);
    await page.screenshot({ path: "test-results/provider-actions-menu.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() => page.getByRole("menu").evaluate((el) => getComputedStyle(el).backgroundColor))
      .toBe("rgb(43, 43, 43)");
    await page.screenshot({ path: "test-results/provider-actions-menu-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await item.click();
    await expect(page.getByRole("button", { name: "确认删除", exact: true })).toBeInViewport();
    await page.screenshot({ path: "test-results/provider-delete-confirm.png" });
    await page.getByRole("button", { name: "取消", exact: true }).click();
    const trigger = page.getByRole("button", { name: "供应商操作", exact: true });
    await trigger.click();
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    const rename = page.getByLabel("重命名供应商", { exact: true });
    await expect(rename).toBeFocused();
    await rename.fill("取消重命名");
    await rename.press("Escape");
    await expect(page.locator(".provider-detail-heading h2")).toHaveText("菜单测试");
    await trigger.click();
    await page.getByRole("menuitem", { name: "重命名", exact: true }).click();
    await rename.fill("重命名后");
    await rename.press("Enter");
    await expect(page.locator(".provider-detail-heading h2")).toHaveText("重命名后");
    await expect(page.locator('[data-provider-id="delete"]')).toContainText("重命名后");
    await trigger.scrollIntoViewIfNeeded();
    await trigger.focus();
    await trigger.press("Enter");
    await item.press("Enter");
    await page.getByRole("button", { name: "确认删除", exact: true }).click();
    await expect(page.locator('[data-provider-id="delete"]')).toHaveCount(0);
    await expect(page.locator('[data-provider-id="keep"]')).toHaveCount(1);
    await page.reload();
    const settings = await page.evaluate(() => window.ZPI.getSettings());
    expect(settings.ok && settings.value.providers.map((provider) => provider.id)).toEqual(["keep"]);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
