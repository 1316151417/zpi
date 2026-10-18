import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

async function expectCompactActions(page: Page, name: string) {
  const dialog = page.locator(".provider-delete-dialog");
  await expect(dialog).toBeVisible();
  await dialog.evaluate((element) =>
    Promise.all(element.getAnimations().map((animation) => animation.finished)),
  );
  const measurements = await dialog.locator("footer button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const range = document.createRange();
      range.selectNodeContents(button);
      const text = range.getBoundingClientRect();
      const bounds = button.getBoundingClientRect();
      return {
        extraWidth: bounds.width - text.width,
        centerOffset: Math.abs(bounds.x + bounds.width / 2 - text.x - text.width / 2),
        height: bounds.height,
      };
    }),
  );
  expect(measurements).toHaveLength(2);
  for (const measurement of measurements) {
    expect(measurement.extraWidth).toBeGreaterThanOrEqual(30);
    expect(measurement.extraWidth).toBeLessThanOrEqual(34);
    expect(measurement.centerOffset).toBeLessThan(1);
    expect(measurement.height).toBe(36);
  }
  await page.screenshot({ path: test.info().outputPath(`${name}.png`) });
  await dialog.getByRole("button", { name: /^取消/ }).click();
  await expect(dialog).toHaveCount(0);
}

for (const theme of ["light", "dark"] as const) {
  test(`confirmation buttons fit their labels and shortcut hints in ${theme} mode`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-confirmation-layout-"));
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, url: "" });
      const page = await app.firstWindow();
      await page.evaluate(async (theme) => {
        for (const result of [
          await window.zpi.updatePreferences({ theme, fontSize: theme === "dark" ? 18 : 14 }),
          await window.zpi.saveProvider({
            id: "layout-provider",
            name: "Layout Provider",
            baseUrl: "http://127.0.0.1:9",
            apiKey: "test-key",
            models: [{ id: "fake", reasoning: false }],
          }),
          await window.zpi.saveWebSearch({ provider: "deepseek", apiKey: "test-web-key", enabled: false }),
        ])
          if (!result.ok) throw new Error(result.error.message);
      }, theme);
      await page.reload();
      await page.setViewportSize({ width: 900, height: 720 });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "快捷键", exact: true }).click();
      await page.getByLabel("清除选择模型快捷键", { exact: true }).click();
      await page.getByRole("button", { name: "全部恢复默认", exact: true }).click();
      await expectCompactActions(page, "shortcut-reset");
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "供应商操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "删除", exact: true }).click();
      await expectCompactActions(page, "provider-delete");
      await page.getByRole("button", { name: "联网搜索", exact: true }).click();
      await page.getByRole("button", { name: "供应商操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "移除 API Key", exact: true }).click();
      await expectCompactActions(page, "web-key-remove");
    } finally {
      await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
    }
  });
}
