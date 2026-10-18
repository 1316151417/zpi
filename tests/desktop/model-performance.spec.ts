import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("fits cumulative metrics below the composer without changing the bottom height in all layouts", async () => {
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
          prompt_tokens_details: { cached_tokens: 80 },
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
    const composer = page.locator(".composer").first();
    await expect(indicator).toHaveCount(0);
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const toggle = settings.getByRole("checkbox", { name: "显示模型性能与用量", exact: true });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await settings.getByLabel("关闭设置").click();
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await settings.getByLabel("关闭设置").click();
    await expect(indicator).toHaveCount(0);

    await editor.fill("性能任务 A");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect(page.locator(".conversation")).toContainText("正在检查请求与用量。");
    await expect(indicator).toHaveCount(0);
    const initialBox = await composer.boundingBox();
    expect(initialBox).not.toBeNull();
    more.resolve();

    // Run another task while A is still streaming; its missing usage must not inherit A's speed.
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(indicator).toHaveCount(0);
    await editor.fill("性能任务 B");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(indicator).toHaveText("1 轮 1 步");
    await page.getByTestId("session-row").filter({ hasText: "性能任务 A" }).click();
    await expect(indicator).toHaveCount(0);
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(indicator).toContainText("1 轮 1 步");
    await expect(indicator).toContainText("185 tok");
    await expect(indicator).toContainText("缓存命中 80%");
    expect(await composer.boundingBox()).toEqual(initialBox);
    const live = (await indicator.textContent()) ?? "";
    await indicator.getByRole("button", { name: "会话统计", exact: true }).click();
    const stats = page.getByRole("dialog", { name: "会话统计", exact: true });
    await expect(stats).toContainText("模型用时");
    await expect(stats).toContainText("轮数1");
    await expect(stats).toContainText("步数1");
    await expect(stats).toContainText("首 token 平均（TTFT）");
    await expect(stats).toContainText("输出速度（TPS）");
    await page.keyboard.press("Escape");
    await expect(stats).toHaveCount(0);
    await indicator.getByRole("button", { name: "Token 用量", exact: true }).click();
    const usage = page.getByRole("dialog", { name: "Token 用量", exact: true });
    await expect(usage).toContainText("未缓存输入20 tok");
    await expect(usage).toContainText("缓存读取80 tok");
    await expect(usage).toContainText("输出85 tok");
    await page.keyboard.press("Escape");

    for (const [theme, width, name] of [
      ["浅色", 1800, "wide"],
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
      await toggle.uncheck();
      await settings.getByLabel("关闭设置").click();
      await expect(indicator).toHaveCount(0);
      const withoutMetrics = await composer.boundingBox();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await toggle.check();
      await settings.getByLabel("关闭设置").click();
      await expect(indicator).toBeVisible();
      expect(await composer.boundingBox()).toEqual(withoutMetrics);
      await expect(composer.getByTestId("model-performance")).toHaveCount(0);
      await expect
        .poll(async () => {
          const input = await composer.boundingBox();
          const metric = await indicator.boundingBox();
          const dock = await page.locator(".composer-container").first().boundingBox();
          if (!input || !metric || !dock) return false;
          return (
            metric.x >= input.x &&
            metric.x + metric.width <= input.x + input.width &&
            metric.y >= input.y + input.height &&
            metric.y + metric.height <= dock.y + dock.height &&
            metric.height <= 12
          );
        })
        .toBe(true);
      await editor.fill("可以继续输入");
      await expect(editor).toBeFocused();
      await page.screenshot({ animations: "disabled", path: `test-results/model-performance-${name}.png` });
      await page
        .locator(".composer-container")
        .first()
        .screenshot({
          animations: "disabled",
          path: `test-results/model-performance-${name}-composer.png`,
        });
      await indicator.getByRole("button", { name: "会话统计", exact: true }).click();
      await expect(stats).toBeVisible();
      const panel = await stats.boundingBox();
      expect(panel && panel.x >= 0 && panel.x + panel.width <= width).toBeTruthy();
      await page.screenshot({
        animations: "disabled",
        path: `test-results/model-performance-${name}-details.png`,
      });
      await page.keyboard.press("Escape");
      await expect(stats).toHaveCount(0);
      await indicator.getByRole("button", { name: "Token 用量", exact: true }).click();
      await expect(usage).toBeVisible();
      await page.screenshot({
        animations: "disabled",
        path: `test-results/model-performance-${name}-usage.png`,
      });
      await page.keyboard.press("Escape");
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
    await expect(indicator).toHaveText(live);
    next.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(indicator).toContainText("2 轮 2 步");
    await expect(indicator).toContainText("370 tok");
    const final = (await indicator.textContent()) ?? "";
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    const reopened = await app.firstWindow();
    await reopened.getByTestId("session-row").filter({ hasText: "性能任务 A" }).click();
    await expect(reopened.getByTestId("model-performance")).toHaveText(final);
    await reopened.getByLabel("消息", { exact: true }).fill("重启后继续");
    await reopened.getByLabel("发送", { exact: true }).click();
    await expect(reopened.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(reopened.getByTestId("model-performance")).toContainText("3 轮 3 步");
    await expect(reopened.getByTestId("model-performance")).toContainText("555 tok");
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
