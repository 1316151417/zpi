import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, fakeServer, send } from "../fake-server.ts";
import { select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("stop hover matches ZCode in both themes, without a shortcut badge and working stop controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-stop-hover-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "正在生成" }));
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const id = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await select(page, id);
    const editor = page.getByLabel("消息", { exact: true });
    const stop = page.getByLabel("停止", { exact: true });
    const tooltip = page.locator(".control-hint-tooltip").filter({ hasText: "停止生成" });
    // ZCode: secondary/80 on hover; ControlHintTooltip at top, offset 2.
    for (const [theme, background, hintBackground, hintColor] of [
      ["light", "rgb(230, 230, 230)", "rgb(240, 240, 240)", "rgb(13, 13, 13)"],
      ["dark", "rgb(54, 54, 54)", "rgb(43, 43, 43)", "rgb(248, 248, 248)"],
    ] as const) {
      await page.evaluate((theme) => window.ZPI.updatePreferences({ theme }), theme);
      await editor.fill(`检查停止按钮 ${theme}`);
      await editor.press("Enter");
      await expect(stop).toBeVisible();
      await editor.hover();
      await expect(stop).toHaveCSS("background-color", background);
      await expect(stop).toHaveCSS("width", "28px");
      await expect(stop).toHaveCSS("height", "28px");
      await expect(stop).toHaveCSS("border-radius", "8px");
      await expect(stop.locator("svg")).toHaveCSS("width", "16px");
      await expect(stop.locator("svg")).toHaveCSS("stroke-width", "1.5px");
      await expect(stop).not.toHaveAttribute("title");
      const iconColor = await stop.locator("svg").evaluate((el) => getComputedStyle(el).color);
      await stop.hover();
      await expect(stop).toHaveCSS("background-color", /^oklab\(.+ \/ 0\.8\)$/);
      await expect(stop).toHaveCSS("filter", "none");
      await expect(stop.locator("svg")).toHaveCSS("color", iconColor);
      await expect(tooltip).toBeVisible();
      await expect(tooltip).toContainText("停止生成");
      await expect(tooltip).toHaveAttribute("data-side", "top");
      await expect(tooltip).toHaveCSS("background-color", hintBackground);
      await expect(tooltip).toHaveCSS("color", hintColor);
      await expect(tooltip).toHaveCSS("border-radius", "8px");
      await expect(tooltip).toHaveCSS("padding", "4px 10px");
      await expect(tooltip).toHaveCSS("font-size", "12px");
      await expect(tooltip.locator(":scope > span").first()).toHaveCSS("font-weight", "500");
      await expect(tooltip.locator("kbd")).toHaveCount(0);
      const buttonBounds = await stop.boundingBox();
      const hintBounds = await tooltip.boundingBox();
      if (!buttonBounds || !hintBounds) throw new Error("stop control bounds");
      expect(buttonBounds.y - hintBounds.y - hintBounds.height).toBe(2);
      await page.screenshot({
        path: `test-results/stop-hover-${theme}.png`,
        clip: {
          x: hintBounds.x - 8,
          y: hintBounds.y - 8,
          width: hintBounds.width + 16,
          height: buttonBounds.y + buttonBounds.height - hintBounds.y + 16,
        },
      });
      await page.screenshot({ path: `test-results/stop-hint-${theme}.png` });
      const editorBounds = await editor.boundingBox();
      if (!editorBounds) throw new Error("message editor bounds");
      // Leave the controls vertically so the path does not hover the model picker.
      // Continued movement lets Radix close its hover grace area.
      await page.mouse.move(
        buttonBounds.x + buttonBounds.width / 2,
        editorBounds.y + editorBounds.height / 2,
        { steps: 12 },
      );
      await page.mouse.move(
        editorBounds.x + editorBounds.width / 2,
        editorBounds.y + editorBounds.height / 2,
        { steps: 12 },
      );
      await expect(tooltip).toHaveCount(0);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expect(stop).toHaveCSS("background-color", background);
      if (theme === "light") await stop.click();
      else await editor.press("Escape");
      await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
      await expect(stop).toHaveCount(0);
    }
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
