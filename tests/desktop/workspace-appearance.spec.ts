import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  if (!box) throw new Error("Expected a visible panel");
  return box;
}

test("workspace has independent rounded panels, transparent gutters and ZCode launcher fills", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-workspace-appearance-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1440, 900));
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(page.locator(".composer-stack.with-header")).toHaveCSS(
      "box-shadow",
      "rgba(0, 0, 0, 0.05) 0px 20px 25px -5px, rgba(0, 0, 0, 0.05) 0px 8px 10px -6px",
    );
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
    const main = page.locator(".shell > main");
    const frame = page.locator(".right-pane-frame");
    const leftHandle = page.getByRole("separator", { name: "侧边栏宽度", exact: true });
    const rightHandle = page.getByRole("separator", { name: "右侧栏宽度", exact: true });
    const launcher = page.locator(".pane-empty-launcher");
    const mac = await app.evaluate(() => process.platform === "darwin");
    const panelRadius = await app.evaluate(() =>
      process.platform === "win32"
        ? 5
        : process.platform === "darwin" && Number.parseInt(process.getSystemVersion(), 10) < 26
          ? 6
          : 12,
    );
    if (mac) {
      // Electron's getter normalizes the transparent native background to RGB.
      expect(
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.getBackgroundColor()),
      ).toBe("#000000");
      await expect(page.locator("html")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    }
    // Reference: ZCode DesktopWindowFrame and theme-zai light/dark tokens.
    async function expectBackdrop(dark = false) {
      const expected = await page.evaluate(
        ({ mac, dark }) => {
          const ref = document.createElement("div");
          ref.style.backgroundColor = mac
            ? `color-mix(in oklab, ${dark ? "#2b2b2b 60%" : "#f8f8f8 70%"}, transparent)`
            : dark
              ? "#2b2b2b"
              : "#ececee";
          document.body.append(ref);
          const color = getComputedStyle(ref).backgroundColor;
          ref.remove();
          return color;
        },
        { mac, dark },
      );
      await expect(page.locator(".shell")).toHaveCSS("background-color", expected);
    }
    await expectBackdrop();
    await expect(page.locator(".sidebar")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    for (const panel of [main, frame]) {
      await expect(panel).toHaveCSS("background-color", "rgb(248, 248, 248)");
      await expect(panel).toHaveCSS("border-radius", `${panelRadius}px`);
      await expect(panel).toHaveCSS("overflow", "hidden");
      const box = await bounds(panel);
      expect(box?.y).toBe(4);
      expect(box?.height).toBe(viewport.height - 8);
    }
    const sidebarBox = await bounds(page.locator(".sidebar"));
    const mainBox = await bounds(main);
    const frameBox = await bounds(frame);
    expect(mainBox.x - sidebarBox.width).toBe(4);
    expect(frameBox.x - mainBox.x - mainBox.width).toBe(4);
    expect(frameBox.x + frameBox.width).toBe(viewport.width - 4);
    for (const handle of [leftHandle, rightHandle]) {
      await expect(handle).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(handle).toHaveCSS("width", "4px");
      await handle.hover();
      await expect.poll(() => handle.evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("1");
    }
    for (const name of ["变更", "终端", "浏览器"]) {
      await expect(launcher.getByRole("button", { name, exact: true })).toHaveCSS(
        "background-color",
        "rgba(13, 13, 13, 0.03)",
      );
    }
    await expect(launcher.locator("h2")).toHaveCSS("font-size", "20px");
    await expect(launcher.locator(".pane-launcher-actions")).toHaveCSS("display", "grid");
    await expect(launcher.getByRole("button", { name: "浏览器", exact: true })).toHaveCSS("height", "88px");
    await page.mouse.move(0, 0);
    await expect.poll(() => rightHandle.evaluate((el) => getComputedStyle(el, "::after").opacity)).toBe("0");
    await page.screenshot({ path: "test-results/workspace-rounded-panels.png" });
    const initialWidth = sidebarBox.width;
    await leftHandle.press("ArrowRight");
    await expect.poll(async () => (await bounds(page.locator(".sidebar")))?.width).toBe(initialWidth + 16);
    await rightHandle.press("ArrowLeft");
    await expect.poll(async () => (await bounds(frame))?.width).toBeGreaterThan(frameBox.width);
    await page.getByLabel("收起侧边栏", { exact: true }).click();
    await expect.poll(async () => (await bounds(main))?.x).toBe(0);
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(frame).toBeHidden();
    await expect
      .poll(async () => {
        const box = await bounds(main);
        return box.x + box.width;
      })
      .toBe(viewport.width - 4);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.emulateMedia({ colorScheme: "dark" });
    await expectBackdrop(true);
    await expect(main).toHaveCSS("background-color", "rgb(22, 22, 22)");
    await expect(frame).toHaveCSS("background-color", "rgb(22, 22, 22)");
    await expect(launcher.getByRole("button", { name: "浏览器", exact: true })).toHaveCSS(
      "background-color",
      "rgba(255, 255, 255, 0.05)",
    );
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 640));
    await expect
      .poll(async () => {
        const box = await bounds(frame);
        const viewport = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
        return [box.y, box.height - viewport.height, box.x + box.width - viewport.width];
      })
      .toEqual([4, -8, -4]);
    await expect(launcher.locator(".pane-launcher-actions")).toHaveCSS("display", "flex");
    await expect(launcher.getByRole("button", { name: "浏览器", exact: true })).toHaveCSS("height", "48px");
    await page.screenshot({ path: "test-results/workspace-rounded-panels-narrow-dark.png" });
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
