import { once } from "node:events";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("native reading anchors survive delayed images above a partial turn while ignoring growth below", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-reading-images-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seed = seedHistory(dir, cwd, 60);
  const above = deferred(),
    below = deferred();
  const images = createServer(async (request, response) => {
    await (request.url === "/above" ? above.promise : below.promise);
    response.setHeader("content-type", "image/svg+xml");
    response.end(
      '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="960"><rect width="640" height="960" fill="blue"/></svg>',
    );
  });
  images.listen(0, "127.0.0.1");
  await once(images, "listening");
  const url = `http://127.0.0.1:${(images.address() as AddressInfo).port}`;
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        content: `![above](${url}/above)\n\n${"Paragraph above reader.\n\n".repeat(20)}READING_ANCHOR\n\n${"Paragraph below reader.\n\n".repeat(30)}![below](${url}/below)`,
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await page.addInitScript(
      (id) =>
        localStorage.setItem(
          `zpi.reading.${id}`,
          JSON.stringify({ top: 0, following: false, cursor: 0, runId: "run-0", offset: 0 }),
        ),
      seed.id,
    );
    await page.reload();
    await expect(page.locator("[data-history-run]")).toHaveCount(60);
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("Create delayed images");
    await editor.press("Enter");
    const run = page.getByTestId("run").last();
    await expect(run).toHaveAttribute("data-status", "completed");
    await run.locator("img").evaluateAll((nodes) => {
      for (const node of nodes) (node as HTMLImageElement).loading = "eager";
    });
    const anchor = run.getByText("READING_ANCHOR", { exact: true });
    await anchor.evaluate((node) => node.scrollIntoView({ block: "center" }));
    await page.locator(".conversation").dispatchEvent("wheel", { deltaY: -1 });
    await expect(anchor).toBeInViewport();
    const bounds = await run.boundingBox(),
      viewport = await page.locator(".conversation").boundingBox();
    expect(
      bounds && viewport && bounds.y < viewport.y && bounds.y + bounds.height > viewport.y + viewport.height,
    ).toBe(true);
    const y = (await anchor.boundingBox())?.y ?? 0;
    const top = await page.locator(".conversation").evaluate((node) => node.scrollTop);
    above.resolve();
    await expect(run.locator('img[alt="above"]')).toHaveJSProperty("naturalHeight", 960);
    await expect.poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - y)).toBeLessThan(3);
    await expect
      .poll(() => page.locator(".conversation").evaluate((node) => node.scrollTop))
      .toBeGreaterThan(top + 100);
    const afterAbove = await page.locator(".conversation").evaluate((node) => node.scrollTop);
    below.resolve();
    await expect(run.locator('img[alt="below"]')).toHaveJSProperty("naturalHeight", 960);
    await expect.poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - y)).toBeLessThan(3);
    expect(await page.locator(".conversation").evaluate((node) => node.scrollTop)).toBeCloseTo(afterAbove, 0);
    await page.locator(".conversation-inner").evaluate((node) => {
      const notice = document.createElement("div");
      notice.style.height = "64px";
      notice.textContent = "History failed notice";
      node.prepend(notice);
    });
    await expect.poll(async () => Math.abs(((await anchor.boundingBox())?.y ?? 0) - y)).toBeLessThan(3);
  } finally {
    above.resolve();
    below.resolve();
    await runCleanup([
      () => new Promise<void>((resolve) => images.close(() => resolve())),
      () => images.closeAllConnections(),
      server.close,
      () => rm(dir, { recursive: true, force: true }),
      () => app?.close(),
    ]);
  }
});
