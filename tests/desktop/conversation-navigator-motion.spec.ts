import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("navigator fades and slides across sidebar changes without unmounting, including reduced motion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-navigator-motion-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 20);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    const navigator = page.locator(".conversation-navigator");
    await expect(navigator).toBeVisible();
    await expect(navigator).toHaveAttribute("aria-busy", "false");
    const retained = await navigator.elementHandle();
    if (!retained) throw new Error("Missing history navigator");
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme, reducedMotion: "no-preference" });
      await expect(navigator).toHaveCSS("opacity", "1");
      for (const opening of [true, false]) {
        const middle = await page.evaluate(async () => {
          const navigator = document.querySelector<HTMLElement>(".conversation-navigator");
          const toggle = document.querySelector<HTMLButtonElement>('[data-testid="right-sidebar-toggle"]');
          if (!navigator || !toggle) throw new Error("Missing navigator or sidebar toggle");
          const first = navigator.querySelector("button");
          toggle.click();
          const started = performance.now();
          while (performance.now() - started < 2000) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (!navigator.isConnected) throw new Error("Navigator unmounted during sidebar animation");
            const animations = navigator.getAnimations();
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
            const style = getComputedStyle(navigator);
            const sample = {
              opacity: Number(style.opacity),
              x: new DOMMatrixReadOnly(style.transform).m41,
              visibility: style.visibility,
              inert: navigator.inert,
              sameButton: navigator.querySelector("button") === first,
              transitions: animations.map((animation) => ({
                property: animation instanceof CSSTransition ? animation.transitionProperty : "",
                duration: animation.effect?.getTiming().duration,
                easing: animation.effect?.getTiming().easing,
              })),
            };
            for (const animation of animations) animation.finish();
            return sample;
          }
          throw new Error("Navigator did not animate when the sidebar changed width");
        });
        expect(middle.opacity).toBeGreaterThan(0);
        expect(middle.opacity).toBeLessThan(1);
        expect(middle.x).toBeGreaterThan(-8);
        expect(middle.x).toBeLessThan(0);
        expect(middle.visibility).toBe("visible");
        expect(middle.inert).toBe(opening);
        expect(middle.sameButton).toBe(true);
        for (const property of ["opacity", "transform"])
          expect(middle.transitions).toContainEqual({ property, duration: 150, easing: "ease-out" });
        if (opening) {
          await expect(navigator).toBeHidden();
          await expect(navigator).toHaveCSS("opacity", "0");
        } else {
          await expect(navigator).toBeVisible();
          await expect(navigator).toHaveCSS("opacity", "1");
        }
        expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
      }
    }
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(navigator).toBeHidden();
    await expect(navigator).toHaveCSS("opacity", "0");
    expect(await navigator.evaluate((node) => node.getAnimations().length)).toBe(0);
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(navigator).toBeVisible();
    await expect(navigator).toHaveCSS("opacity", "1");
    expect(await navigator.evaluate((node) => node.getAnimations().length)).toBe(0);
    expect(await retained.evaluate((node) => node.isConnected)).toBe(true);
    await navigator.getByRole("button", { name: "跳转到第 1 条问题" }).click();
    await expect(page.locator('[data-find-key="run-0:user"]')).toBeInViewport();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
