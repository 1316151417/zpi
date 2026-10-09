import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("right pane slides in both layouts, locks content during toggles and resizes without lag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-pane-motion-"));
  const app = await launchDesktop({ dir, url: "" });
  try {
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    const panel = page.locator(".right-pane");
    await expect(page.getByTestId("right-sidebar-toggle")).toBeVisible();
    await expect(page.locator(".right-pane-content")).toBeAttached();
    for (const width of [1200, 900]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 800),
        width,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      for (const opening of [true, false]) {
        const middle = await page.evaluate(async () => {
          const toggle = document.querySelector<HTMLButtonElement>('[data-testid="right-sidebar-toggle"]');
          const panel = document.querySelector<HTMLElement>(".right-pane");
          const content = document.querySelector<HTMLElement>(".right-pane-content");
          if (!toggle || !panel || !content) throw Error("Missing pane controls");
          toggle.click();
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          const animations = panel.getAnimations();
          const transition = animations.find(
            (animation) => animation instanceof CSSTransition && animation.transitionProperty === "width",
          );
          if (!transition) throw Error("Expected a width transition when toggling the pane");
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = 100;
          }
          const measured = {
            width: panel.getBoundingClientRect().width,
            target: Number.parseFloat(getComputedStyle(panel).getPropertyValue("--right-pane-width")),
            contentWidth: content.getBoundingClientRect().width,
            inert: panel.inert,
          };
          for (const animation of animations) animation.play();
          await Promise.allSettled(animations.map((animation) => animation.finished));
          return measured;
        });
        expect(middle.width).toBeGreaterThan(0);
        expect(middle.width).toBeLessThan(middle.target);
        expect(middle.contentWidth).toBeCloseTo(middle.target - 2, 1);
        expect(middle.inert).toBe(!opening);
      }
      await expect(panel).toBeHidden();
    }
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(panel).not.toHaveAttribute("data-animating", "true");
    const handle = page.getByRole("separator", { name: "右侧栏宽度", exact: true });
    const box = await handle.boundingBox();
    if (!box) throw Error("Missing pane resize handle");
    await page.mouse.move(box.x + 2, box.y + 100);
    await page.mouse.down();
    await expect(panel).toHaveAttribute("data-resizing", "true");
    await page.mouse.move(box.x - 60, box.y + 100);
    await expect(panel).toHaveCSS("transition-duration", "0s");
    await expect
      .poll(() =>
        panel.evaluate(
          (el) =>
            el.getBoundingClientRect().width -
            Number.parseFloat(getComputedStyle(el).getPropertyValue("--right-pane-width")),
        ),
      )
      .toBeCloseTo(0, 1);
    await page.mouse.up();
    await expect(panel).not.toHaveAttribute("data-resizing", "true");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(1200);
    expect(
      await panel.evaluate((el) =>
        el
          .getAnimations()
          .some(
            (animation) => animation instanceof CSSTransition && animation.transitionProperty === "width",
          ),
      ),
    ).toBe(false);
    // A fast reversal must finish open and keep its launcher mounted.
    await page.evaluate(async () => {
      const toggle = document.querySelector<HTMLButtonElement>('[data-testid="right-sidebar-toggle"]');
      toggle?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
      toggle?.click();
    });
    await expect(panel).not.toHaveAttribute("data-animating", "true");
    await expect(page.locator(".pane-empty-launcher")).toBeVisible();
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(panel).toHaveCSS("transition-duration", "0s");
    await expect(panel).toBeVisible();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
