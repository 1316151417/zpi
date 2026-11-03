import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("guides a live run twice, navigates each input and restores them without resending", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-user-guides-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 1);
  const release = deferred();
  const server = await fakeServer(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((message) => message.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "Original response remains intact.\n\n".repeat(30) }));
    if (user === "hold live run") await release.promise;
    if (!response.destroyed) done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1600, height: 900 });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("hold live run");
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(1);
    const run = page.getByTestId("run").last();
    const runId = await run.getAttribute("data-run-id");
    await editor.fill("first real guide");
    await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Enter`);
    await expect(editor).toHaveText("");
    await expect(run).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("queue-item")).toHaveCount(1);
    await editor.fill("second real guide");
    await editor.press("Enter");
    await page
      .getByTestId("queue-item")
      .filter({ hasText: "second real guide" })
      .getByRole("button", { name: "立即", exact: true })
      .click();
    expect(server.requests).toHaveLength(1);
    release.resolve();
    await expect(run).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(run.locator(".guide-message")).toHaveCount(2);
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    const ids = await run
      .locator(".guide-message")
      .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.guideId));
    expect(new Set(ids).size).toBe(2);
    const rail = page.getByRole("navigation", { name: "对话问题导航" });
    for (const [index, text] of [
      [3, "first real guide"],
      [4, "second real guide"],
    ] as const) {
      await rail.getByRole("button", { name: `跳转到第 ${index} 条问题`, exact: true }).click();
      const target = run.locator(".guide-message").filter({ hasText: text });
      await expect(target).toBeInViewport();
      await expect
        .poll(async () => {
          const bounds = await target.boundingBox();
          const viewport = await page.locator(".conversation").boundingBox();
          return Math.abs((bounds?.y ?? 0) - (viewport?.y ?? 0));
        })
        .toBeLessThan(12);
    }
    await page.reload();
    const restored = page.locator(`[data-run-id="${runId}"]`);
    await expect(restored.locator(".guide-message")).toHaveCount(2);
    expect(
      await restored
        .locator(".guide-message")
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.guideId)),
    ).toEqual(ids);
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    expect(server.requests).toHaveLength(2);
  } finally {
    release.resolve();
    await runCleanup([server.close, () => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
