import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("ZCode reasoning chips edit, add, remove and reorder; custom mappings survive reload and reach inference", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-reasoning-editor-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const app = await launchDesktop({ dir, url: server.url });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async (url) => {
      const result = await window.zpi.saveProvider({
        id: "domestic",
        name: "国产模型",
        baseUrl: url,
        apiKey: "isolated",
        models: [
          {
            id: "binary",
            name: "二档模型",
            reasoning: true,
            input: ["text", "image"],
            useRecommendedConfig: true,
            metadataSource: "catalog",
            contextWindow: 1000000,
            maxTokens: 384000,
            compat: { thinkingFormat: "deepseek", supportsReasoningEffort: false },
          },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
    }, server.url);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.getByRole("button", { name: "国产模型", exact: true }).click();
    await page.getByLabel("编辑模型 binary", { exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "编辑模型配置", exact: true });
    await dialog.getByRole("button", { name: "高级配置", exact: true }).click();
    const chips = dialog.locator(".model-reasoning-value");
    await expect(chips).toHaveText(["none", "high"]);
    expect(
      await dialog
        .locator(".model-reasoning-chip")
        .first()
        .evaluate((el) => el.getBoundingClientRect().height),
    ).toBe(32);
    await dialog.locator(".model-config-advanced").evaluate(async (el) => {
      await Promise.all(el.getAnimations({ subtree: true }).map((animation) => animation.finished) ?? []);
    });
    await page.screenshot({ path: "test-results/zcode-reasoning-editor-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/zcode-reasoning-editor-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await dialog.getByRole("button", { name: "none", exact: true }).click();
    const name = dialog.getByLabel("推理等级名称", { exact: true });
    await name.fill("disabled");
    await name.press("Enter");
    await dialog.getByRole("button", { name: "添加推理等级", exact: true }).click();
    await name.fill("high");
    await name.press("Enter");
    await expect(name).toBeVisible();
    await name.press("Escape");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "添加推理等级", exact: true }).click();
    await name.fill("balanced");
    await name.press("Enter");
    await dialog.getByRole("button", { name: "balanced", exact: true }).press("Alt+ArrowLeft");
    await expect(chips).toHaveText(["disabled", "balanced", "high"]);
    await dialog
      .locator(".model-reasoning-chip")
      .filter({ hasText: "high" })
      .dragTo(dialog.locator(".model-reasoning-chip").filter({ hasText: "disabled" }));
    await expect(chips).toHaveText(["high", "disabled", "balanced"]);
    await dialog.getByRole("button", { name: "删除推理等级: high", exact: true }).click();
    await expect(chips).toHaveText(["disabled", "balanced"]);
    const mapping = dialog.getByLabel("推理参数映射", { exact: true });
    await mapping.fill('reasoningLevel == "disabled" ? {} : null');
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog.getByRole("alert")).toContainText("JSON object");
    await expect(dialog).toBeVisible();
    await mapping.fill(`reasoningLevel == "disabled"
      ? {"thinking": {"type": "disabled"}}
      : {"thinking": {"type": "enabled"}, "reasoning_effort": "low"}`);
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    const stored = await page.evaluate(() => window.zpi.getSettings());
    expect(
      stored.ok && stored.value.providers.find((p) => p.id === "domestic")?.models[0].reasoningConfig?.levels,
    ).toEqual(["disabled", "balanced"]);
    await page.getByLabel("关闭设置", { exact: true }).click();
    await page.getByLabel("模型选择", { exact: true }).click();
    await page.getByRole("menuitem", { name: "二档模型", exact: true }).click();
    await page.getByRole("menuitem", { name: "balanced", exact: true }).click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("balanced");
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)).toMatchObject({ thinking: { type: "enabled" }, reasoning_effort: "low" });
    await page.reload();
    await expect(page.getByLabel("模型选择", { exact: true })).toContainText("balanced");
    await page.getByLabel("模型选择", { exact: true }).click();
    await page.getByRole("menuitem", { name: "二档模型", exact: true }).click();
    await page.getByRole("menuitem", { name: "关闭", exact: true }).click();
    await editor.fill("disabled");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.thinking).toEqual({ type: "disabled" });
    expect(server.requests.at(-1)?.reasoning_effort).toBeUndefined();
  } finally {
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
