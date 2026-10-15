import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("persists the switch, streams accurate metrics per task and centers below the composer in all layouts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-performance-"));
  const more = deferred();
  const finish = deferred();
  const next = deferred();
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const input = messages.findLast((m) => m.role === "user")?.content;
    if (input === "重新统计") await next.promise;
    await delay(180);
    send(response, chunk({ reasoning_content: "正在检查请求与用量。" }));
    if (input === "性能任务 A") await more.promise;
    await delay(200);
    send(response, chunk({ content: "模型性能已经就绪，输入框可继续正常使用。" }));
    if (input !== "性能任务 B")
      send(response, {
        ...chunk({}),
        choices: [],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 85,
          total_tokens: 185,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      });
    if (input === "性能任务 A") await finish.promise;
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const indicator = page.getByTestId("model-performance");
    const editor = page.getByLabel("消息", { exact: true });
    await expect(indicator).toHaveCount(0);
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const toggle = settings.getByRole("checkbox", { name: "显示模型性能", exact: true });
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await settings.getByLabel("关闭设置").click();
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(toggle).toBeChecked();
    await settings.getByLabel("关闭设置").click();
    await expect(indicator).toHaveCount(0);

    await editor.fill("性能任务 A");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(indicator).toHaveText(/^TTFT (?:<)?[\d.]+ s$/);
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    more.resolve();
    await expect(indicator).toHaveText(/[\d.]+ tok\/s · TTFT /);
    const live = await indicator.innerText();

    // Run another task while A is still streaming; its missing usage must not inherit A's speed.
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(indicator).toHaveCount(0);
    await editor.fill("性能任务 B");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(indicator).toHaveText(/^TTFT (?:<)?[\d.]+ s$/);
    await page.getByTestId("session-row").filter({ hasText: "性能任务 A" }).click();
    await expect(indicator).toHaveText(live);
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(indicator).toHaveText(live); // Waiting for terminal metadata does not lower speed.

    for (const [theme, width, name] of [
      ["浅色", 1200, "light"],
      ["深色", 1200, "dark"],
      ["深色", 900, "narrow"],
    ] as const) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 800),
        width,
      );
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
      await page.getByRole("option", { name: theme, exact: true }).click();
      await settings.getByLabel("关闭设置").click();
      await expect(indicator).toBeVisible();
      const composer = page.locator(".composer").first();
      await expect
        .poll(async () => {
          const input = await composer.boundingBox();
          const metric = await indicator.boundingBox();
          if (!input || !metric) return false;
          return (
            Math.abs(input.x + input.width / 2 - metric.x - metric.width / 2) < 1 &&
            metric.y >= input.y + input.height &&
            metric.y + metric.height <= 800
          );
        })
        .toBe(true);
      await editor.fill("可以继续输入");
      await expect(editor).toBeFocused();
      await page.screenshot({ path: `test-results/model-performance-${name}.png` });
      await editor.fill("");
    }
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await toggle.uncheck();
    await settings.getByLabel("关闭设置").click();
    await expect(indicator).toHaveCount(0);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await toggle.check();
    await settings.getByLabel("关闭设置").click();
    await expect(indicator).toHaveText(live);
    await editor.fill("重新统计");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(indicator).toHaveCount(0);
    next.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(indicator).toContainText("tok/s");
  } finally {
    more.resolve();
    finish.resolve();
    next.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
