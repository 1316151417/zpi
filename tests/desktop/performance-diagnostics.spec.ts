import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("records a renderer long task and responsiveness events in the isolated local log", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-performance-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    await expect(editor).toBeVisible();
    expect(await page.evaluate(() => PerformanceObserver.supportedEntryTypes)).toContain("longtask");
    await editor.fill("PRIVATE_DIAGNOSTIC_CONTENT");
    await app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      contents.emit("unresponsive");
      contents.emit("responsive");
    });
    // Exercise Chromium's real observer; this short stall affects only the hidden test renderer.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => {
          setTimeout(() => {
            const end = performance.now() + 300;
            while (performance.now() < end) {}
            resolve();
          }, 0);
        }),
    );
    const logPath = join(dir, "agent", "logs", "error.log");
    await expect
      .poll(
        async () =>
          (await readFile(logPath, "utf8"))
            .trim()
            .split("\n")
            .some((line) => {
              const record = JSON.parse(line);
              return (
                record.source === "renderer.performance" &&
                JSON.parse(record.message).operation === "long-task"
              );
            }),
        { timeout: 15_000 },
      )
      .toBe(true);
    const contents = await readFile(logPath, "utf8");
    const records = contents
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const summary = records.find(
      (record) =>
        record.source === "renderer.performance" && JSON.parse(record.message).operation === "long-task",
    );
    expect(JSON.parse(summary.message)).toMatchObject({ operation: "long-task", count: expect.any(Number) });
    expect(JSON.parse(summary.message).maxMs).toBeGreaterThanOrEqual(200);
    expect(records).toContainEqual(expect.objectContaining({ source: "renderer.unresponsive" }));
    expect(records).toContainEqual(
      expect.objectContaining({ source: "renderer.responsive", durationMs: expect.any(Number) }),
    );
    expect(contents).not.toContain("PRIVATE_DIAGNOSTIC_CONTENT");
    await editor.fill("仍可输入");
    await expect(editor).toHaveText("仍可输入");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
