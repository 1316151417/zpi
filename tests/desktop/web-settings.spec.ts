import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

// Uses the official hidden-window fixture. No DeepSeek request is made by this settings-only test.
for (const colorScheme of ["light", "dark"] as const) {
  test(`web settings preserve independent secrets and navigation in ${colorScheme} mode`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-web-settings-desktop-"));
    const server = await fakeServer((_, response) => {
      send(response, chunk({ content: "ok" }));
      done(response);
    });
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, url: server.url });
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "插件能力", exact: true }).click();
      const enabled = page.getByRole("checkbox", { name: "联网搜索", exact: true });
      await expect(enabled).not.toBeChecked();
      await enabled.check();
      await page.getByRole("button", { name: "联网搜索", exact: true }).click();
      const key = page.getByLabel("API Key", { exact: true });
      await expect(key).toHaveAttribute("type", "password");
      await key.fill("fake-desktop-web-key");
      await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
      await expect(key).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByText("已保存联网搜索设置。", { exact: true })).toBeVisible();
      await expect(key).toHaveValue("");
      await expect(key).toHaveAttribute("type", "password");
      const settings = await page.evaluate(() => window.zpi.getSettings());
      expect(settings.ok && settings.value.webSearch.hasApiKey).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("fake-desktop-web-key");
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "联网搜索", exact: true }).click();
      await expect(key).toHaveValue("");
      await expect(key).toHaveAttribute("placeholder", "已配置，留空保留现有 API Key");
      await page.getByRole("button", { name: "移除 API Key", exact: true }).click();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("button", { name: "移除 API Key", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "移除 API Key", exact: true }).click();
      await page.getByRole("button", { name: "确认移除", exact: true }).click();
      await expect(page.getByText("已移除 API Key。", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "移除 API Key", exact: true })).toHaveCount(0);
      await page.screenshot({ path: `test-results/web-settings-${colorScheme}.png`, animations: "disabled" });
    } finally {
      await runCleanup([
        () => rm(dir, { recursive: true, force: true }),
        server.close,
        async () => {
          await app?.close();
        },
      ]);
    }
  });
}
