import type { Page } from "@playwright/test";
import { expect } from "./test.ts";

// Start before the pointer/scroll event and inspect every rendered frame, including
// Radix's 150ms exit presence. Waiting only for eventual removal misses the flash.
export async function expectNoCornerTooltipDuring(page: Page, action: () => Promise<unknown>) {
  const monitor = await page.evaluateHandle(() => {
    const state = {
      endAt: Number.POSITIVE_INFINITY,
      frames: 0,
      ghosts: [] as Array<{ x: number; y: number; text: string | null }>,
      done: Promise.resolve(),
    };
    state.done = new Promise<void>((resolve) => {
      const sample = () => {
        state.frames++;
        for (const tooltip of document.querySelectorAll<HTMLElement>(".control-hint-tooltip")) {
          const wrapper = tooltip.closest<HTMLElement>("[data-radix-popper-content-wrapper]");
          if (!wrapper) continue;
          const bounds = wrapper.getBoundingClientRect();
          const style = getComputedStyle(tooltip);
          if (
            style.visibility !== "hidden" &&
            style.display !== "none" &&
            Number(style.opacity) > 0 &&
            bounds.width > 0 &&
            bounds.height > 0 &&
            bounds.x >= -1 &&
            bounds.x < 24 &&
            bounds.y >= -1 &&
            bounds.y < 24
          ) {
            state.ghosts.push({ x: bounds.x, y: bounds.y, text: tooltip.textContent });
          }
        }
        if (performance.now() < state.endAt) requestAnimationFrame(sample);
        else resolve();
      };
      requestAnimationFrame(sample);
    });
    return state;
  });
  try {
    await action();
    const result = await monitor.evaluate(async (state) => {
      state.endAt = performance.now() + 250;
      await state.done;
      return { frames: state.frames, ghosts: state.ghosts };
    });
    expect(result.frames).toBeGreaterThan(2);
    expect(result.ghosts).toEqual([]);
  } finally {
    await monitor.evaluate((state) => {
      state.endAt = 0;
    });
    await monitor.dispose();
  }
}
