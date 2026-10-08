import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("context indicator hides after compaction and returns when the next response reports usage", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-context-compaction-"));
  const next = deferred();
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const user = messages.findLast((message) => message.role === "user")?.content;
    send(response, chunk({ content: "response" }));
    if (user === "after compaction") await next.promise;
    send(response, {
      ...chunk({}),
      choices: [],
      usage: { prompt_tokens: 2048, completion_tokens: 8, total_tokens: 2056 },
    });
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const indicator = page.getByRole("button", { name: "上下文占用", exact: true });
    await expect(indicator).toHaveCount(0);
    for (const [index, message] of ["first", "second"].entries()) {
      await page.getByLabel("消息", { exact: true }).fill(message);
      await page.getByLabel("发送", { exact: true }).click();
      await expect(page.getByTestId("run")).toHaveCount(index + 1);
      await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    }
    await expect(indicator).toBeVisible();
    await page.getByLabel("消息", { exact: true }).fill("/compact");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(
      page.getByText("上下文已压缩；完整历史保留，下一次请求使用摘要和最近回合。", { exact: true }),
    ).toBeVisible();
    await expect(indicator).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("run")).toHaveCount(3);
    await expect(indicator).toHaveCount(0);
    await page.getByLabel("消息", { exact: true }).fill("after compaction");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(indicator).toHaveCount(0);
    next.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(indicator).toBeVisible();
  } finally {
    next.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("context indicator appears after the first response and keeps measured usage across model switches and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-context-indicator-"));
  const first = deferred();
  const second = deferred();
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const user = messages.findLast((message) => message.role === "user")?.content;
    send(response, chunk({ content: `response ${user}` }));
    await (user === "first" ? first.promise : second.promise);
    send(response, {
      ...chunk({}),
      choices: [],
      usage: {
        prompt_tokens: body.model === "context-other" ? 1024 : 2048,
        completion_tokens: 8,
        total_tokens: body.model === "context-other" ? 1032 : 2056,
        prompt_tokens_details: { cached_tokens: body.model === "context-other" ? 512 : 1536 },
      },
    });
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await page.evaluate(async (url) => {
      const result = await window.ZPI.saveProvider({
        id: "context-other",
        name: "Other provider",
        baseUrl: url,
        apiKey: "isolated-key",
        models: [{ id: "context-other", reasoning: false, contextWindow: 4096, maxTokens: 512 }],
      });
      if (!result.ok) throw new Error(result.error.message);
    }, server.url);
    await page.reload();
    const choose = async (model: string) => {
      await page.getByLabel("模型选择", { exact: true }).click();
      await page.getByRole("menuitem", { name: model, exact: true }).hover();
      await page.getByRole("menuitem", { name: "关闭", exact: true }).click();
      await expect(page.getByLabel("模型选择", { exact: true })).toContainText(model);
    };
    const indicator = () => page.getByRole("button", { name: "上下文占用", exact: true });
    const tooltip = () => page.getByRole("tooltip");
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await expect(indicator()).toHaveCount(0);
    await page.getByLabel("消息", { exact: true }).fill("first");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.locator(".answer")).toContainText("response first");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect(indicator()).toHaveCount(0);
    first.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(indicator()).toBeVisible();
    await indicator().hover();
    await expect(tooltip()).toContainText("75.0%");
    const breakdown = await page.getByTestId("context-breakdown").innerText();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 900));
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    const rightHandle = page.getByRole("separator", { name: "右侧栏宽度", exact: true });
    for (let i = 0; i < 9; i++) await rightHandle.press("ArrowLeft");
    const panel = page.locator(".shell > main");
    await expect.poll(async () => (await panel.boundingBox())?.width).toBeLessThan(400);
    const expectUnclippedTooltip = async () => {
      await expect(tooltip()).toBeVisible();
      await expect
        .poll(async () => {
          const popup = await tooltip().boundingBox();
          const main = await panel.boundingBox();
          return Boolean(
            popup &&
              main &&
              popup.x >= main.x + 8 &&
              popup.x + popup.width <= main.x + main.width - 8 &&
              popup.y >= main.y + 8 &&
              popup.y + popup.height <= main.y + main.height - 8,
          );
        })
        .toBe(true);
      expect(
        await tooltip().evaluate((el) => {
          const box = el.getBoundingClientRect();
          return [
            [box.left + 8, box.top + 8],
            [box.right - 8, box.top + 8],
            [box.left + 8, box.bottom - 8],
            [box.right - 8, box.bottom - 8],
          ].every(([x, y]) => el.contains(document.elementFromPoint(x, y)));
        }),
      ).toBe(true);
    };
    await indicator().hover();
    await expectUnclippedTooltip();
    await page.screenshot({ path: "test-results/context-indicator-narrow-panel.png" });
    await page.mouse.move(0, 0);
    await expect(tooltip()).toBeHidden();
    await indicator().focus();
    await expectUnclippedTooltip();
    await indicator().press("Escape");
    await expect(tooltip()).toBeHidden();
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await choose("context-other");
    await indicator().hover();
    await expect(tooltip()).not.toContainText("未知");
    await expect(page.getByTestId("context-breakdown")).toHaveText(breakdown, { useInnerText: true });
    await expect(tooltip().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "50");
    await page.getByLabel("消息", { exact: true }).fill("second");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(indicator()).toBeVisible();
    await indicator().hover();
    await expect(tooltip()).not.toContainText("未知");
    await expect(page.getByTestId("context-breakdown")).toHaveText(breakdown, { useInnerText: true });
    second.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await indicator().hover();
    await expect(tooltip().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    await page.screenshot({ path: "test-results/context-indicator.png" });
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(indicator()).toBeVisible();
    await indicator().hover();
    await expect(tooltip().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "25");
    const restoredBreakdown = await page.getByTestId("context-breakdown").innerText();
    await choose("fake");
    await indicator().hover();
    await expect(tooltip()).not.toContainText("未知");
    await expect(page.getByTestId("context-breakdown")).toHaveText(restoredBreakdown, { useInnerText: true });
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(page.getByTestId("run")).toHaveCount(0);
    await expect(indicator()).toHaveCount(0);
  } finally {
    first.resolve();
    second.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
