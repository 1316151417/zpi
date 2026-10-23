import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("switching sidebar tasks restores full-view geometry without pane opening transitions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-pane-switch-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "Done." }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const title of ["Full view task", "Other task"]) {
      await page.getByLabel("新建任务", { exact: true }).first().click();
      await page.getByLabel("消息", { exact: true }).fill(title);
      await page.getByLabel("消息", { exact: true }).press("Enter");
      await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
      if (title === "Full view task") {
        await page.getByTestId("right-sidebar-toggle").click();
        await page.getByLabel("进入完整视图", { exact: true }).click();
        await page.getByLabel("消息", { exact: true }).fill("Keep this draft");
      }
    }
    const fullTask = page.getByTestId("session-row").filter({ hasText: "Full view task" });
    const otherTask = page.getByTestId("session-row").filter({ hasText: "Other task" });
    const fullId = await fullTask.getAttribute("data-session-id");
    const otherId = await otherTask.getAttribute("data-session-id");
    if (!fullId || !otherId) throw Error("Missing task rows");
    const taskIds: string[] = [fullId, otherId];
    for (const otherLayout of ["closed", "split", "full"]) {
      if (otherLayout === "split") await page.getByTestId("right-sidebar-toggle").click();
      if (otherLayout === "full") await page.getByLabel("进入完整视图", { exact: true }).click();
      for (const id of taskIds) {
        const frames = await page.evaluate(async (targetId: string) => {
          const row = document.querySelector<HTMLElement>(`[data-session-id="${targetId}"]`);
          const panel = document.querySelector<HTMLElement>(".right-pane");
          const content = document.querySelector<HTMLElement>(".right-pane-content");
          const main = document.querySelector<HTMLElement>(".main");
          const shell = document.querySelector(".shell");
          if (!row || !panel || !content || !main || !shell) throw Error("Missing workspace");
          row.click();
          const frames = [];
          for (let frame = 0; frame < 20; frame++) {
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (!row.classList.contains("active")) continue;
            const paneRect = panel.getBoundingClientRect();
            const contentRect = content.getBoundingClientRect();
            const mainRect = main.getBoundingClientRect();
            frames.push({
              full: shell.classList.contains("pane-full-view"),
              hidden: getComputedStyle(panel).display === "none",
              animations: panel.getAnimations().length,
              contentGap: paneRect.width - contentRect.width,
              floatingRight: contentRect.right - mainRect.right,
            });
          }
          return frames;
        }, id);
        expect(frames.length).toBeGreaterThan(0);
        for (const frame of frames) {
          expect(frame.animations).toBe(0);
          expect(frame.full).toBe(id === fullId || otherLayout === "full");
          expect(frame.hidden).toBe(id === otherId && otherLayout === "closed");
          if (frame.full) {
            expect(frame.contentGap).toBeCloseTo(2, 1);
            expect(frame.floatingRight).toBeCloseTo(16, 1);
          }
        }
        if (id === fullId)
          await expect(page.getByLabel("消息", { exact: true })).toHaveText("Keep this draft");
      }
    }
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});

test("right pane slides with stable content in both layouts and resizes without lag", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-pane-motion-"));
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: "" });
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
          const layoutTransitions = animations.filter(
            (animation) =>
              animation instanceof CSSTransition &&
              ["width", "margin-right"].includes(animation.transitionProperty),
          );
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = 100;
          }
          const measured = {
            layoutTransitions: layoutTransitions.length,
            width: panel.getBoundingClientRect().width,
            target: Number.parseFloat(getComputedStyle(panel).getPropertyValue("--right-pane-width")),
            contentWidth: content.getBoundingClientRect().width,
            inert: panel.inert,
          };
          for (const animation of animations) animation.play();
          await Promise.allSettled(animations.map((animation) => animation.finished));
          return measured;
        });
        expect(middle.layoutTransitions).toBe(2);
        expect(middle.width).toBeGreaterThan(0);
        expect(middle.width).toBeLessThan(middle.target);
        expect(middle.contentWidth).toBeCloseTo(middle.target - 2, 1);
        expect(middle.inert).toBe(!opening);
      }
      await expect(panel).toBeHidden();
    }
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    // The resize handle moves during opening; measure it only after the transition finishes.
    await expect(panel).not.toHaveAttribute("data-animating", "true");
    const handle = page.getByRole("separator", { name: "右侧栏宽度", exact: true });
    const box = await handle.boundingBox();
    if (!box) throw Error("Missing pane resize handle");
    await page.mouse.move(box.x + 2, box.y + 100);
    await page.mouse.down();
    await expect(panel).toHaveAttribute("data-resizing", "true");
    await expect(panel).not.toHaveAttribute("data-animating", "true");
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
    await expect(page.locator(".pane-empty-launcher")).toBeVisible();
    await expect(panel).not.toHaveAttribute("data-animating", "true");
    await expect(panel).not.toHaveAttribute("hidden");
    await expect(panel).not.toHaveAttribute("inert");
    // Keyboard resizing during an opening transition must immediately cancel the tween.
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(panel).toBeHidden();
    const keyboardResize = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="right-sidebar-toggle"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      document
        .querySelector(".right-resizer")
        ?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const panel = document.querySelector<HTMLElement>(".right-pane");
      if (!panel) throw Error("Missing pane");
      return {
        animating: panel.hasAttribute("data-animating"),
        width: panel.getBoundingClientRect().width,
        target: Number.parseFloat(getComputedStyle(panel).getPropertyValue("--right-pane-width")),
      };
    });
    expect(keyboardResize.animating).toBe(false);
    expect(keyboardResize.width).toBeCloseTo(keyboardResize.target, 1);
    // A native resize also cancels an in-flight opening rather than chasing the viewport.
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(panel).toBeHidden();
    await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="right-sidebar-toggle"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      window.dispatchEvent(new Event("resize"));
    });
    await expect(panel).not.toHaveAttribute("data-animating", "true");
    expect(
      await panel.evaluate((el) =>
        el
          .getAnimations()
          .some(
            (animation) => animation instanceof CSSTransition && animation.transitionProperty === "width",
          ),
      ),
    ).toBe(false);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(panel).toBeHidden();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(panel).toHaveCSS("transition-duration", "0s");
    await expect(panel).toBeVisible();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
