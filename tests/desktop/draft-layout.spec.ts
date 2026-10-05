import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("default window, draft spacing and fixed sidebar footer match ZCode", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-draft-layout-"));
  const projects = await Promise.all(
    Array.from({ length: 24 }, async (_, index) => {
      const path = join(dir, `project-${index}`);
      await mkdir(path);
      return { id: `project-${index}`, name: `Project ${index}`, path, updatedAt: Date.now() };
    }),
  );
  await writeFile(join(dir, "projects.json"), JSON.stringify(projects));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const windowSize = await app.evaluate(({ BrowserWindow, screen }) => ({
      size: BrowserWindow.getAllWindows()[0].getSize(),
      workArea: screen.getPrimaryDisplay().workAreaSize,
    }));
    expect(windowSize.size).toEqual([
      Math.min(1200, windowSize.workArea.width),
      Math.min(800, windowSize.workArea.height),
    ]);
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByLabel("新建任务", { exact: true }).first().click();
    const input = page.getByLabel("消息", { exact: true });
    const header = page.locator(".topbar");
    const footer = page.locator(".sidebar-footer");
    await expect(header).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
    await expect(footer).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(".composer-stack.with-header")).toHaveCSS(
      "background-color",
      "rgba(13, 13, 13, 0.03)",
    );
    for (const size of [
      [1200, 800],
      [900, 640],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        size,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size[0]);
      const geometry = await page.evaluate(() => {
        const body = document.querySelector(".task-body");
        const greeting = document.querySelector(".draft-greeting");
        const composer = document.querySelector(".composer-stack");
        if (!body || !greeting || !composer) throw Error("Missing draft layout");
        return {
          viewport: innerHeight,
          topSpace: greeting.getBoundingClientRect().top - body.getBoundingClientRect().top,
          dockGap: composer.getBoundingClientRect().top - greeting.getBoundingClientRect().bottom,
          width: composer.getBoundingClientRect().width,
          fontSize: Number.parseFloat(getComputedStyle(greeting).fontSize),
        };
      });
      expect(geometry.topSpace).toBeCloseTo(geometry.viewport * 0.29, 1);
      expect(geometry.dockGap).toBe(44);
      expect(geometry.width).toBeLessThanOrEqual(672);
      expect(geometry.fontSize).toBe(30);
      await expect(input).toBeInViewport();
      await page.screenshot({ path: `test-results/draft-layout-${size[0]}.png` });
      const footerBox = await footer.boundingBox();
      const scroll = page.locator(".sidebar-sections");
      expect(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
      await scroll.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      expect(await footer.boundingBox()).toEqual(footerBox);
      await expect(footer.getByRole("button", { name: "设置", exact: true })).toBeInViewport();
    }
    await input.fill("顶栏边线");
    await input.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect
      .poll(() => header.evaluate((el) => getComputedStyle(el).borderBottomColor))
      .toMatch(/\/ 0\.05\d*\)/);
    await expect(header).toHaveCSS("border-bottom-width", "1px");
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(header).toHaveCSS("border-bottom-color", "rgba(0, 0, 0, 0)");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
