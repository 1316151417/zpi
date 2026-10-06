import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

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
      await page.getByRole("menuitem", { name: model, exact: true }).click();
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
