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
      await page.getByRole("button", { name: "扩展能力", exact: true }).click();
      await expect(page.getByRole("checkbox", { name: "联网搜索", exact: true })).toHaveCount(0);
      await page.getByRole("button", { name: "联网搜索", exact: true }).click();
      const enabled = page.getByRole("switch", { name: "启用联网搜索", exact: true });
      const header = page.locator(".web-search-settings .settings-page-heading");
      await expect(header.getByRole("heading", { name: "联网搜索", exact: true })).toBeVisible();
      await expect(header.getByRole("switch", { name: "启用联网搜索", exact: true })).toBeVisible();
      const headerLayout = await header.evaluate((element) => {
        const title = element.querySelector("h1")?.getBoundingClientRect();
        const toggle = element.querySelector(".settings-enable")?.getBoundingClientRect();
        if (!title || !toggle) throw new Error("Missing header controls");
        return {
          gap: toggle.left - title.right,
          centers: Math.abs((toggle.top + toggle.bottom - title.top - title.bottom) / 2),
        };
      });
      expect(headerLayout.gap).toBeGreaterThan(32);
      expect(headerLayout.centers).toBeLessThan(2);
      await expect(enabled).not.toBeChecked();
      await expect(enabled).toBeDisabled();
      const key = page.getByLabel("API Key", { exact: true });
      const originalViewport = page.viewportSize() ?? { width: 1280, height: 900 };
      for (const width of [1280, 800, 640, 480]) {
        await page.setViewportSize({ width, height: 900 });
        const panel = page.locator(".web-search-provider-panel");
        await expect(panel.locator(".provider-list button")).toHaveCount(1);
        await expect(panel.getByRole("button", { name: "DeepSeek", exact: true })).toHaveAttribute(
          "aria-current",
          "true",
        );
        await expect(panel.getByRole("button", { name: "新增提供商", exact: true })).toHaveCount(0);
        const layout = await panel.evaluate((element) => {
          const nav = element.querySelector<HTMLElement>(".provider-list");
          const editor = element.querySelector<HTMLElement>(".provider-editor");
          const field = element.querySelector<HTMLInputElement>("#web-search-api-key");
          if (!nav || !editor || !field) throw new Error("Missing web settings layout");
          return {
            height: element.getBoundingClientRect().height,
            navRight: nav.getBoundingClientRect().right,
            editorLeft: editor.getBoundingClientRect().left,
            fieldRight: field.getBoundingClientRect().right,
            editorRight: editor.getBoundingClientRect().right,
            overflow: element.scrollWidth > element.clientWidth,
          };
        });
        expect(layout.navRight).toBeLessThanOrEqual(layout.editorLeft + 1);
        expect(layout.fieldRight).toBeLessThanOrEqual(layout.editorRight);
        expect(layout.height).toBeLessThan(400);
        expect(layout.overflow).toBe(false);
      }
      await page.setViewportSize(originalViewport);
      await expect(key).toHaveAttribute("type", "password");
      await key.fill("fake-desktop-web-key");
      await page.getByRole("button", { name: "显示 API Key", exact: true }).click();
      await expect(key).toHaveAttribute("type", "text");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(page.getByText("已保存 API Key。", { exact: true })).toBeVisible();
      await expect(key).toHaveValue("*".repeat("fake-desktop-web-key".length));
      await expect(key).toHaveAttribute("type", "password");
      const settings = await page.evaluate(() => window.zpi.getSettings());
      expect(settings.ok && settings.value.webSearch.hasApiKey).toBe(true);
      expect(JSON.stringify(settings)).not.toContain("fake-desktop-web-key");
      await expect(enabled).toBeDisabled();
      const providerSwitch = page.getByRole("switch", { name: "启用供应商 DeepSeek 联网服务", exact: true });
      await providerSwitch.click();
      await expect(providerSwitch).toBeChecked();
      await expect(enabled).toBeEnabled();
      await enabled.click();
      await expect(enabled).toBeChecked();
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.getByRole("button", { name: "联网搜索", exact: true }).click();
      await expect(key).toHaveValue("*".repeat("fake-desktop-web-key".length));
      await page.getByRole("button", { name: "显示 API Key", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(key).toHaveValue("fake-desktop-web-key");
      await expect(key).toHaveAttribute("type", "text");
      await key.selectText();
      await expect(key).toHaveValue("fake-desktop-web-key");
      await page.getByRole("button", { name: "隐藏 API Key", exact: true }).focus();
      await page.keyboard.press("Space");
      await expect(key).toHaveAttribute("type", "password");
      await expect(key).toHaveValue("*".repeat("fake-desktop-web-key".length));
      await page.getByRole("button", { name: "供应商操作", exact: true }).click();
      await page.getByRole("menuitem", { name: "移除 API Key", exact: true }).click();
      await page.getByRole("button", { name: "取消", exact: true }).click();
      await page.getByRole("button", { name: "供应商操作", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "移除 API Key", exact: true })).toBeVisible();
      await page.getByRole("menuitem", { name: "移除 API Key", exact: true }).click();
      await page.getByRole("button", { name: "确认移除", exact: true }).click();
      await expect(page.getByText("已移除 API Key。", { exact: true })).toBeVisible();
      await expect(enabled).not.toBeChecked();
      await expect(enabled).toBeDisabled();
      await expect(page.getByRole("menuitem", { name: "移除 API Key", exact: true })).toHaveCount(0);
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
