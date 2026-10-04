import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { create, select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("packaged ten complete Agent calls, upward paging, reading position and restart; title hover is complete", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-history-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seed = seedHistory(dir, cwd, 30);
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "reply" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, packaged: true });
    let page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await page.locator(".conversation").evaluate((el) => {
      el.scrollTop = 0;
    });
    const first = page.getByTestId("run").filter({ hasText: "用户上下文 20" });
    const before = (await first.boundingBox())?.y;
    await page.getByRole("button", { name: "加载更早的十次调用" }).click();
    await expect(page.getByTestId("run")).toHaveCount(20);
    await expect
      .poll(async () => Math.abs(((await first.boundingBox())?.y ?? 0) - (before ?? 0)))
      .toBeLessThan(4);
    const scroll = await page.locator(".conversation").evaluate((el) => el.scrollTop);
    await create(page);
    await select(page, seed.id);
    await expect(page.getByTestId("run")).toHaveCount(20);
    await expect
      .poll(() => page.locator(".conversation").evaluate((el) => el.scrollTop))
      .toBeCloseTo(scroll, 0);
    await app.close();
    app = await launchDesktop({ dir, url: server.url, packaged: true });
    page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(20);
    await expect
      .poll(() => page.locator(".conversation").evaluate((el) => el.scrollTop))
      .toBeCloseTo(scroll, 0);
    await page.screenshot({ path: "test-results/desktop-history-paged.png" });
    const latest = page.getByRole("button", { name: "回到最新" });
    await expect(latest).toHaveText("");
    const background = await latest.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(background).not.toContain("rgba");
    await latest.hover();
    expect(await latest.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(background);
    await page.screenshot({ path: "test-results/desktop-latest-circle.png" });
    await latest.click();
    await expect(latest).toBeHidden();
    const title = "这是一个保存完整内容、仅在窄侧边栏和顶部视觉省略的会话标题";
    await page.evaluate(
      async ({ id, title }) => {
        const r = await window.zpi.renameSession(id, title);
        if (!r.ok) throw Error(r.error.message);
      },
      { id: seed.id, title },
    );
    await expect(page.locator(".topbar-title")).toHaveText(title);
    await expect(page.locator(".topbar-title")).toHaveAttribute("title", title);
    await expect(
      page.locator(`.recent-sessions .session-row[data-session-id="${seed.id}"] .session-name`),
    ).toHaveAttribute("title", title);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
