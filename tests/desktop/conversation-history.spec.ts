import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("windows long history while preserving streaming, find, selection and reading anchors", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-history-window-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seed = seedHistory(dir, cwd, 60);
  const release = deferred();
  const server = await fakeServer(async (_, response) => {
    send(response, chunk({ content: "运行中正文\n\n".repeat(40) }));
    await release.promise;
    send(response, chunk({ content: "后续正文\n\n".repeat(40) }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await page.addInitScript(
      (id) =>
        localStorage.setItem(
          `zpi.reading.${id}`,
          JSON.stringify({
            following: false,
            cursor: 0,
            top: 0,
            runId: "run-0",
            offset: 0,
          }),
        ),
      seed.id,
    );
    await page.reload();
    const area = () => page.locator(".conversation");
    const turn = (id: string) => page.locator(`[data-run-id="${id}"]`);
    await expect(page.locator("[data-history-run]")).toHaveCount(60);
    await expect(area()).toHaveAttribute("data-windowed", "true");
    await expect(turn("run-0")).toBeInViewport();
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
    await page.getByLabel("消息", { exact: true }).fill("继续长会话");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("run").last().locator(".answer")).toContainText("运行中正文");
    const jump = async (runId: string) => {
      await page.evaluate(
        ({ sessionId, runId }) =>
          window.dispatchEvent(
            new CustomEvent("zpi:scroll-to-run", {
              detail: { sessionId, runId },
            }),
          ),
        { sessionId: seed.id, runId },
      );
      await expect(turn(runId)).toBeInViewport();
    };
    await jump("run-30");
    const before = (await turn("run-30").boundingBox())?.y;
    release.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect
      .poll(async () => Math.abs(((await turn("run-30").boundingBox())?.y ?? 0) - (before ?? 0)))
      .toBeLessThan(4);
    await jump("run-0");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const find = page.getByRole("dialog", { name: "在任务中查找" }).getByRole("textbox");
    await find.fill("最终回复 17");
    await expect(page.getByRole("dialog", { name: "在任务中查找" }).getByRole("status")).toHaveText("1/1");
    await expect(turn("run-17").locator(".answer")).toBeInViewport();
    await find.press("Escape");
    await expect(area()).toHaveAttribute("data-windowed", "true");
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
    const selected = await turn("run-17")
      .locator(".answer")
      .evaluate((node) => {
        const range = document.createRange();
        range.selectNodeContents(node);
        document.getSelection()?.removeAllRanges();
        document.getSelection()?.addRange(range);
        document.dispatchEvent(new Event("selectionchange"));
        return document.getSelection()?.toString();
      });
    await jump("run-0");
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(selected);
    await expect(turn("run-17")).toHaveCount(1);
    await page.evaluate(() => {
      document.getSelection()?.removeAllRanges();
      document.dispatchEvent(new Event("selectionchange"));
    });
    await expect(turn("run-17")).toHaveCount(0);
    await jump("run-30");
    await expect
      .poll(() =>
        page.evaluate(
          (id) => JSON.parse(localStorage.getItem(`zpi.reading.${id}`) ?? "null")?.runId,
          seed.id,
        ),
      )
      .toBe("run-30");
    const savedTop = ((await turn("run-30").boundingBox())?.y ?? 0) - ((await area().boundingBox())?.y ?? 0);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(turn("run-30")).toBeInViewport();
    await expect
      .poll(async () =>
        Math.abs(
          ((await turn("run-30").boundingBox())?.y ?? 0) - ((await area().boundingBox())?.y ?? 0) - savedTop,
        ),
      )
      .toBeLessThan(4);
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThanOrEqual(40);
    await expect(page.locator('[data-history-run="run-0"]')).toHaveCount(0);
  } finally {
    release.resolve();
    await runCleanup([server.close, () => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("prepending history preserves its anchor when the windowing threshold is crossed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-history-prepend-window-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 60);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect(page.locator("[data-history-run]")).toHaveCount(10);
    for (let loaded = 10; loaded < 60; loaded += 10) {
      const anchorId = `run-${60 - loaded + 1}`;
      const before = await page.locator(".conversation").evaluate((root, id) => {
        root.scrollTop = 80;
        const anchor = root.querySelector(`[data-history-run="${id}"]`);
        if (!anchor) throw new Error("Missing loaded history anchor");
        return anchor.getBoundingClientRect().y;
      }, anchorId);
      await expect(page.locator("[data-history-run]")).toHaveCount(loaded + 10);
      await expect
        .poll(
          () =>
            page
              .locator(`[data-history-run="${anchorId}"]`)
              .evaluate((node) => node.getBoundingClientRect().y),
          { message: `Anchor after loading ${loaded + 10} runs` },
        )
        .toBeCloseTo(before, 0);
    }
    await expect(page.locator(".conversation")).toHaveAttribute("data-windowed", "true");
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
