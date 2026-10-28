import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("pages and searches a single long turn, then preserves it through cancellation and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-single-turn-desktop-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const calls = 160;
  const seed = seedHistory(dir, cwd, calls, { perRun: calls, outputBytes: 16 * 1024 });
  const release = deferred();
  let summaries = 0,
    replies = 0;
  const server = await fakeServer(async (body, response) => {
    if (JSON.stringify(body.messages).includes("ONLY output the structured summary")) {
      summaries++;
      send(response, chunk({ content: "Earlier long-turn work summary" }));
      done(response);
      return;
    }
    replies++;
    send(response, chunk({ content: "新的实时回复" }));
    await release.promise;
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(1);
    await expect(page.getByTestId("run")).toHaveAttribute("data-run-id", "run-0");
    await expect(page.locator(".load-history")).toHaveCount(1);
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const find = page.getByRole("dialog", { name: "在任务中查找" });
    for (const ordinal of [0, 80, 159]) {
      await find.getByRole("textbox").fill(`最终回复 ${ordinal}`);
      await expect(find.getByRole("status")).toHaveText("1/1");
      await expect
        .poll(() =>
          page.evaluate(() =>
            [...(CSS.highlights.get("zpi-conversation-find-active") ?? [])].map((range) => range.toString()),
          ),
        )
        .toEqual([`最终回复 ${ordinal}`]);
      await expect(page.getByTestId("run")).toHaveCount(1);
    }
    await find.getByRole("textbox").press("Escape");
    await expect(page.locator(".load-history")).toHaveCount(0);
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("继续这个长回合之后的任务");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("run").last().locator(".answer")).toContainText("新的实时回复");
    // Main IPC remains available after a large historical context has been restored.
    expect(
      await page.evaluate(async (id) => {
        const result = await window.zpi.getSessionSnapshot(id);
        return result.ok ? result.value.session.id : result.error.message;
      }, seed.id),
    ).toBe(seed.id);
    await page.getByLabel("停止", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
    release.resolve();
    const requestsBeforeRestart = server.requests.length;
    expect(summaries).toBeGreaterThan(0);
    expect(replies).toBe(1);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const restoredFind = page.getByRole("dialog", { name: "在任务中查找" });
    await restoredFind.getByRole("textbox").fill("最终回复 80");
    await expect(restoredFind.getByRole("status")).toHaveText("1/1");
    await expect(page.locator('[data-run-id="run-0"]')).toHaveCount(1);
    expect(server.requests).toHaveLength(requestsBeforeRestart);
  } finally {
    release.resolve();
    await runCleanup([server.close, () => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
