import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("profiles full history navigation and verifies the mounted window", async () => {
  test.setTimeout(120_000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-navigation-profile-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 1000);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 900 });
    const start = Date.now();
    const rail = page.getByRole("navigation", { name: "对话问题导航" });
    await expect(rail).toBeVisible();
    await expect(rail).toHaveAttribute("aria-busy", "false", { timeout: 90_000 });
    const metrics = await page.evaluate(() => ({
      placeholders: document.querySelectorAll("[data-history-run]").length,
      mounted: document.querySelectorAll('[data-history-mounted="true"]').length,
      buttons: document.querySelectorAll(".conversation-navigator-item").length,
    }));
    console.log(JSON.stringify({ ...metrics, durationMs: Date.now() - start }));
    expect(metrics.placeholders).toBeLessThan(160);
    expect(metrics.mounted).toBeLessThan(40);
    expect(metrics.buttons).toBeLessThan(100);
    await rail.locator(".conversation-navigator-rail").evaluate((node) => {
      node.scrollTop = 0;
    });
    await rail.getByRole("button", { name: "跳转到第 1 条问题" }).click();
    const first = page.locator('[data-find-key="run-0:user"]');
    await expect(first).toBeVisible();
    await expect
      .poll(async () => {
        const message = await first.boundingBox();
        const viewport = await page.locator(".conversation").boundingBox();
        return Math.abs((message?.y ?? 0) - (viewport?.y ?? 0));
      })
      .toBeLessThan(12);
    await rail.locator(".conversation-navigator-rail").evaluate((node) => {
      node.scrollTop = 5000;
    });
    await rail.getByRole("button", { name: "跳转到第 501 条问题" }).click();
    await expect(page.locator('[data-find-key="run-500:user"]')).toBeInViewport();
    await rail.locator(".conversation-navigator-rail").evaluate((node) => {
      node.scrollTop = 9500;
    });
    await rail.getByRole("button", { name: "跳转到第 951 条问题" }).click();
    await expect(page.locator('[data-find-key="run-950:user"]')).toBeInViewport();
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const find = page.getByRole("dialog", { name: "在任务中查找" }).getByRole("textbox");
    await find.fill("最终回复 123");
    await expect(page.locator('[data-run-id="run-123"] .answer')).toBeInViewport();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
