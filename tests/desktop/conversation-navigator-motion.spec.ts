import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { hoverConversationNavigator, seedHistory } from "../history-fixture.ts";

test("navigator slides in at the left edge and hides on exit, with keyboard and reduced motion support", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-navigator-motion-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 20);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    const conversation = page.locator("main .conversation-wrap");
    const navigator = page.locator(".conversation-navigator");
    const rail = navigator.locator(".conversation-navigator-rail");
    await expect(navigator).toHaveAttribute("aria-busy", "false");
    await expect(navigator).toHaveCSS("opacity", "0");
    await expect(rail).toHaveCSS("pointer-events", "none");
    const bounds = await conversation.boundingBox();
    if (!bounds) throw new Error("Missing conversation");
    await page.mouse.move(bounds.x + bounds.width - 22, bounds.y + bounds.height - 24);
    await expect(rail).toHaveCSS("pointer-events", "none");
    const retained = await navigator.elementHandle();
    if (!retained) throw new Error("Missing history navigator");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
      for (const entering of [true, false]) {
        const [middle] = await Promise.all([
          navigator.evaluate(async (node) => {
            const first = node.querySelector("button");
            const started = performance.now();
            while (performance.now() - started < 2000) {
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
              if (!node.isConnected) throw new Error("Navigator unmounted during the animation");
              const animations = node.getAnimations();
              if (
                !animations.some(
                  (animation) =>
                    animation instanceof CSSTransition && animation.transitionProperty === "opacity",
                )
              )
                continue;
              for (const animation of animations) {
                animation.pause();
                animation.currentTime = 75;
              }
              const style = getComputedStyle(node);
              const sample = {
                opacity: Number(style.opacity),
                x: new DOMMatrixReadOnly(style.transform).m41,
                sameButton: node.querySelector("button") === first,
                transitions: animations.map((animation) => ({
                  property: animation instanceof CSSTransition ? animation.transitionProperty : "",
                  duration: animation.effect?.getTiming().duration,
                })),
              };
              for (const animation of animations) animation.finish();
              return sample;
            }
            throw new Error("Navigator did not animate when the pointer crossed the reveal area");
          }),
          entering ? hoverConversationNavigator(page) : conversation.hover(),
        ]);
        expect(middle.opacity).toBeGreaterThan(0);
        expect(middle.opacity).toBeLessThan(1);
        expect(middle.x).toBeGreaterThan(-8);
        expect(middle.x).toBeLessThan(0);
        expect(middle.sameButton).toBe(true);
        for (const property of ["opacity", "transform"])
          expect(middle.transitions).toContainEqual({ property, duration: 150 });
        await expect(navigator).toHaveCSS("opacity", entering ? "1" : "0");
        await expect(rail).toHaveCSS("pointer-events", entering ? "auto" : "none");
        expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
      }
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await hoverConversationNavigator(page);
    await expect(navigator).toHaveCSS("opacity", "1");
    expect(await navigator.evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(navigator).toBeHidden();
    await hoverConversationNavigator(page);
    await expect(navigator).toBeHidden();
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(navigator).toBeVisible();
    await expect(navigator).toHaveCSS("opacity", "0");
    const first = navigator.getByRole("button", { name: "跳转到第 1 条问题" });
    await page.keyboard.press("Tab");
    await first.focus();
    await expect(navigator).toHaveCSS("opacity", "1");
    expect(await navigator.evaluate((node) => node.getAnimations().length)).toBe(0);
    expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
    await first.press("Enter");
    await expect(page.locator('[data-find-key="run-0:user"]')).toBeInViewport();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
