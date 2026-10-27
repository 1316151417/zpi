import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import type { DesktopEventEnvelope } from "zpi-ui";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("streams batched deltas through preload and restores a running snapshot without duplicate text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-event-batches-"));
  const suffix = deferred(),
    finish = deferred();
  const server = await fakeServer(async (_, response) => {
    for (let i = 0; i < 100; i++) send(response, chunk({ content: "a" }));
    await suffix.promise;
    for (let i = 0; i < 100; i++) send(response, chunk({ content: "b" }));
    await finish.promise;
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await page.evaluate(() => {
      const state = window as typeof window & { __eventBatches: DesktopEventEnvelope[][] };
      state.__eventBatches = [];
      window.zpi.onEvents((events) => state.__eventBatches.push([...events]));
    });
    await page.getByLabel("消息", { exact: true }).fill("批量流式回归");
    await page.getByLabel("发送", { exact: true }).click();
    const answer = page.getByTestId("run").last().locator(".answer");
    await expect(answer).toHaveText("a".repeat(100));
    const snapshot = await page.evaluate(async () => {
      const batches = (window as typeof window & { __eventBatches: DesktopEventEnvelope[][] }).__eventBatches;
      const started = batches.flat().find((event) => event.event.type === "started");
      if (!started) throw new Error("Missing started event");
      const result = await window.zpi.getSessionSnapshot(started.sessionId);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    suffix.resolve();
    const expected = "a".repeat(100) + "b".repeat(100);
    await expect(answer).toHaveText(expected);
    const batches = await page.evaluate(
      () => (window as typeof window & { __eventBatches: DesktopEventEnvelope[][] }).__eventBatches,
    );
    expect(
      batches.some((batch) => batch.filter((event) => event.event.type === "block_delta").length > 1),
    ).toBe(true);
    const deltas = batches
      .flat()
      .filter((event) => event.sessionId === snapshot.session.id && event.event.type === "block_delta");
    expect(deltas).toHaveLength(200);
    const tail = deltas
      .filter((event) => event.seq > snapshot.seq)
      .map((event) => (event.event.type === "block_delta" ? event.event.delta : ""))
      .join("");
    const prefix = snapshot.view.runs.at(-1)?.orderedBlocks.at(-1);
    expect(prefix?.type === "text" ? prefix.text + tail : undefined).toBe(expected);
    await page.reload();
    await expect(answer).toHaveText(expected);
    finish.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(answer).toHaveText(expected);
  } finally {
    suffix.resolve();
    finish.resolve();
    await runCleanup([server.close, () => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
