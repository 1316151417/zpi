import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import metadata from "../../package.json" with { type: "json" };
import { launchDesktop } from "../helpers/desktop.ts";

test("persists IPC, renderer and main-process errors, rejects malformed reports, and records renderer crashes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-error-log-desktop-"));
  const app = await launchDesktop({ dir, url: "" });
  const file = join(dir, "agent", "logs", "error.log");
  try {
    const page = await app.firstWindow();
    await expect(page.locator(".shell")).toBeVisible();
    await page.evaluate(async () => {
      await window.ZPI.getSessionSnapshot("missing-session");
      window.ZPI.logError({ source: "manual", message: "synthetic handled error", stack: "synthetic stack" });
      window.ZPI.logError({ source: "oversized", message: "x".repeat(32_001) });
      window.ZPI.logError({ source: "invalid", message: 123 } as unknown as Parameters<
        typeof window.ZPI.logError
      >[0]);
      setTimeout(() => {
        throw new Error("synthetic renderer exception");
      }, 0);
      void Promise.reject(new Error("synthetic renderer rejection"));
      console.error("synthetic console error");
    });
    await app.evaluate(({ dialog }) => {
      // Keep Electron's original exception handler, but suppress its native modal during this test.
      dialog.showErrorBox = () => {};
      void Promise.reject(new Error("synthetic main rejection"));
      setImmediate(() => {
        throw new Error("synthetic main exception");
      });
    });
    await expect.poll(async () => await readFile(file, "utf8")).toContain("synthetic main rejection");
    await expect.poll(async () => await readFile(file, "utf8")).toContain("synthetic main exception");
    await expect.poll(async () => await readFile(file, "utf8")).toContain("renderer.unhandled-rejection");
    const records = (await readFile(file, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(records).toContainEqual(
      expect.objectContaining({ source: "ipc", method: "getSessionSnapshot", stack: expect.any(String) }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        source: "renderer.manual",
        message: "synthetic handled error",
        stack: "synthetic stack",
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        source: "renderer.uncaught",
        message: "synthetic renderer exception",
        stack: expect.any(String),
      }),
    );
    expect(records).toContainEqual(
      expect.objectContaining({ source: "renderer.console", message: "synthetic console error" }),
    );
    expect(records.some((record) => ["renderer.oversized", "renderer.invalid"].includes(record.source))).toBe(
      false,
    );
    expect(records.find((record) => record.source === "ipc").version).toBe(metadata.version);
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(),
    );
    await expect.poll(async () => await readFile(file, "utf8")).toContain("renderer.process-gone");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
