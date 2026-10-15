import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("scrolling near older messages loads one page, preserves the anchor and can reach the beginning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-history-auto-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seed = seedHistory(dir, cwd, 30);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    let page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await expect(page.getByRole("button", { name: "回到最新" })).toBeHidden();
    const anchor = page.locator('[data-run-id="run-20"]');
    const before = await page.locator(".conversation").evaluate((el) => {
      el.scrollTop = 80;
      return el.querySelector('[data-run-id="run-20"]')?.getBoundingClientRect().y;
    });
    await expect(page.getByTestId("run")).toHaveCount(20);
    await expect
      .poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - (before ?? 0)))
      .toBeLessThan(4);
    await expect(page.getByRole("button", { name: "回到最新" })).toBeVisible();
    const scroll = await page.locator(".conversation").evaluate((el) => el.scrollTop);
    await page.getByLabel("消息", { exact: true }).focus();
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    page = await app.firstWindow();
    await expect(page.locator(`.session-row[data-session-id="${seed.id}"]`)).toBeVisible();
    await expect(page.getByTestId("run")).toHaveCount(20);
    await expect
      .poll(() => page.locator(".conversation").evaluate((el) => el.scrollTop))
      .toBeCloseTo(scroll, 0);
    await page.locator(".conversation").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.getByTestId("run")).toHaveCount(30);
    await expect(page.locator(".load-history")).toHaveCount(0);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("automatic history failure reports an error without looping, and explicit retry keeps the reading position", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-history-retry-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 30);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await app.evaluate(({ ipcMain }) => {
      const bus = ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      };
      const original = bus._invokeHandlers.get("zpi:call");
      if (!original) throw new Error("Missing IPC handler");
      let calls = 0;
      Object.assign(globalThis, { historyCalls: () => calls });
      ipcMain.removeHandler("zpi:call");
      ipcMain.handle("zpi:call", async (event, method, args) => {
        if (method === "getHistoryPage") {
          calls++;
          if (calls === 1) return { ok: false, error: { code: "storage", message: "历史暂时不可用" } };
        }
        return original(event, method, args);
      });
    });
    await page.locator(".conversation").evaluate((el) => {
      el.scrollTop = 0;
    });
    await expect(page.locator(".conversation").getByRole("alert")).toContainText("历史暂时不可用");
    await expect(page.getByTestId("run")).toHaveCount(10);
    const calls = () =>
      app?.evaluate(() => (globalThis as typeof globalThis & { historyCalls(): number }).historyCalls());
    expect(await calls()).toBe(1);
    await page.getByRole("button", { name: "加载失败，点击重试" }).click({ timeout: 5000 });
    await expect(page.getByTestId("run")).toHaveCount(20);
    await expect(page.locator(".conversation").getByRole("alert")).toHaveCount(0);
    expect(await calls()).toBe(2);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
