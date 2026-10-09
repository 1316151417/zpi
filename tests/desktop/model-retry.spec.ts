import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("shows Pi agent reconnect status, survives reload, recovers, stops waits and only then exposes terminal errors", async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "ZPI-model-retry-"));
  const project = join(dir, "project");
  await mkdir(project);
  await mkdir(join(dir, "agent"));
  await writeFile(join(dir, "agent/settings.json"), JSON.stringify({ retry: { baseDelayMs: 12000 } }));
  const counts = new Map<string, number>();
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const prompt = messages.filter((m) => m.role === "user").at(-1)?.content ?? "";
    const count = (counts.get(prompt) ?? 0) + 1;
    counts.set(prompt, count);
    if (prompt === "partial") {
      send(response, chunk({ content: count === 1 ? "discarded partial" : "recovered stream" }));
      if (count === 1) response.end();
      else done(response);
      return;
    }
    if (prompt === "recover" && count > 3) {
      send(response, chunk({ content: "recovered answer" }));
      done(response);
      return;
    }
    const delay = prompt === "recover" ? "0.4" : prompt === "stop" ? "120" : "0";
    response.writeHead(429, { "content-type": "application/json", "retry-after": delay });
    response.end(
      JSON.stringify({
        error: {
          message: "Rate limit reached for requests",
          ...(prompt === "quota" ? { code: "insufficient_quota" } : {}),
        },
      }),
    );
  });
  const app = await launchDesktop({ dir, project, url: server.url });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const submit = async (text: string) => {
      await page.getByLabel("消息", { exact: true }).fill(text);
      await page.getByLabel("发送", { exact: true }).click();
      await expect(page.getByTestId("run").last().locator(".user-message-text")).toHaveText(text);
    };
    await submit("recover");
    const run = () => page.getByTestId("run").last();
    await expect(run().locator(".chat-loading-spinner")).toBeVisible();
    await expect(page.getByTestId("api-retry-status")).toHaveCount(0);
    await expect(page.getByTestId("api-retry-status")).toHaveText("重新连接中... 1/3");
    await expect(run()).toHaveAttribute("data-status", "running");
    await expect(run().locator(".run-error")).toHaveCount(0);
    await expect(page.getByTestId("api-retry-status")).toHaveAttribute("title", /HTTP 429/);
    await expect(page.getByTestId("api-retry-status")).toHaveCSS("height", "28px");
    await expect(page.locator(".api-retry-label")).toHaveCSS("animation-duration", "4s");
    await expect(page.locator(".api-retry-label")).toHaveCSS("font-weight", "500");
    await page.screenshot({ path: "test-results/model-retry-light.png" });
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await settings.getByRole("button", { name: "界面设置", exact: true }).click();
    await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await settings.getByLabel("关闭设置").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.screenshot({ path: "test-results/model-retry-dark.png" });
    await page.reload();
    await expect(page.getByTestId("api-retry-status")).toHaveText("重新连接中... 1/3");
    await expect(run()).toHaveAttribute("data-status", "completed", { timeout: 15_000 });
    await expect(run().locator(".answer")).toHaveText("recovered answer");
    expect(counts.get("recover")).toBe(4);
    await expect(page.getByTestId("api-retry-status")).toHaveCount(0);
    await submit("partial");
    await expect(run()).toHaveAttribute("data-status", "completed", { timeout: 15000 });
    expect(counts.get("partial")).toBe(2);
    await expect(run().locator(".answer")).toHaveText("recovered stream");
    await expect(run()).not.toContainText("discarded partial");
    await submit("stop");
    await expect(page.getByTestId("api-retry-status")).toHaveText("重新连接中... 1/3");
    await page.getByLabel("停止", { exact: true }).click();
    await expect(run()).toHaveAttribute("data-status", "aborted");
    await expect(page.getByTestId("api-retry-status")).toHaveCount(0);
    expect(counts.get("stop")).toBe(1);
    await submit("quota");
    await expect(run()).toHaveAttribute("data-status", "error");
    await expect(run().locator(".run-error")).toContainText("Rate limit reached");
    expect(counts.get("quota")).toBe(3);
    await writeFile(join(dir, "agent/settings.json"), JSON.stringify({ retry: { baseDelayMs: 0 } }));
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await submit("exhaust");
    await expect(run()).toHaveAttribute("data-status", "error");
    expect(counts.get("exhaust")).toBe(12);
    await expect(run().locator(".run-error")).toContainText("Rate limit reached");
    await expect(page.getByTestId("api-retry-status")).toHaveCount(0);
  } finally {
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
