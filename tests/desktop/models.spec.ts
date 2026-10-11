import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("preset discovery, model configuration and custom provider persist without exposing credentials", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-provider-ui-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    // Intercept only catalog requests in this isolated test process. No vendor credentials or services are used.
    await app.evaluate(({ net }) => {
      const original = net.fetch.bind(net);
      const counter = { calls: 0 };
      Object.assign(globalThis, { catalogRequests: counter });
      net.fetch = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
        if (url === "https://api.deepseek.com/models") {
          counter.calls++;
          return Response.json({
            data: [
              {
                id: "deepseek-flash",
                name: "DeepSeek Flash",
                context_window: 1000000,
                max_output_tokens: 384000,
                input_modalities: ["text", "image"],
                effort: { supported_levels: ["low", "high", "max"] },
              },
              { id: "deepseek-v4-pro", context_window: 1000000, max_output_tokens: 384000 },
            ],
          });
        }
        return original(input, init);
      };
    });
    const page = await app.firstWindow();
    const catalogApp = app;
    const catalogCalls = () =>
      catalogApp.evaluate(
        () => (globalThis as unknown as { catalogRequests: { calls: number } }).catalogRequests.calls,
      );
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await expect(page.locator(".provider-template-grid button")).toHaveCount(9);
    await expect(page.getByRole("button", { name: "保存提供商", exact: true })).toHaveCount(0);
    await page
      .locator(".provider-template-grid")
      .getByRole("button", { name: "DeepSeek", exact: true })
      .click();
    await expect(page.getByLabel("Base URL", { exact: true })).toHaveAttribute("readonly", "");
    await page.getByLabel("API key", { exact: true }).fill("isolated-key");
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await expect(page.locator(".provider-model-row")).toHaveCount(2);
    expect(await catalogCalls()).toBe(1);
    await expect(page.locator(".provider-nav-group h3")).toHaveText("供应商");
    await expect(page.locator(".provider-model-row").first()).toContainText("1M");
    await expect(page.locator(".provider-model-row").first()).toContainText("视觉");
    await page.screenshot({ path: "test-results/desktop-model-settings-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect
      .poll(() =>
        page
          .locator(".model-enabled-switch > span")
          .first()
          .evaluate((el) => getComputedStyle(el).backgroundColor),
      )
      .toBe("rgb(255, 255, 255)");
    await page.screenshot({ path: "test-results/desktop-model-settings-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    // Sort the entire model row; persistence does not refresh the catalog.
    const firstModel = page.locator('[data-model-id="deepseek-flash"]');
    const secondModel = page.locator('[data-model-id="deepseek-v4-pro"]');
    const source = await firstModel.boundingBox();
    const target = await secondModel.boundingBox();
    if (!source || !target) throw Error("Missing model rows");
    await page.mouse.move(source.x + 60, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + 60, target.y + target.height / 2, { steps: 12 });
    await page.mouse.up();
    await expect(page.locator(".provider-model-row").first()).toHaveAttribute(
      "data-model-id",
      "deepseek-v4-pro",
    );
    await expect
      .poll(async () => {
        const value = await page.evaluate(() => window.zpi.getSettings());
        return value.ok ? value.value.providers.find((p) => p.preset === "deepseek")?.models[0]?.id : "";
      })
      .toBe("deepseek-v4-pro");
    expect(await catalogCalls()).toBe(1);
    await page.screenshot({ path: "test-results/desktop-model-order.png" });
    await page.getByLabel("编辑模型 deepseek-flash", { exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("上下文容量")).toHaveValue("1000000");
    await expect(dialog.getByLabel("输出上限", { exact: true })).toHaveValue("384000");
    await dialog.getByText("高级配置", { exact: true }).click();
    await expect(dialog.getByRole("button", { name: "文本", exact: true })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "图片", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await dialog.getByLabel("上下文容量").fill("900000");
    await expect(dialog.getByRole("checkbox", { name: "智能配置", exact: true })).not.toBeChecked();
    await page.screenshot({ path: "test-results/desktop-model-config-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-model-config-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await dialog.getByRole("button", { name: "保存", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await page.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已获取");
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    const saved = await page.evaluate(() => window.zpi.getSettings());
    expect(JSON.stringify(saved)).not.toContain("isolated-key");
    if (!saved.ok) throw new Error(saved.error.message);
    expect(
      saved.value.providers
        .find((provider) => provider.preset === "deepseek")
        ?.models.find((model) => model.id === "deepseek-flash"),
    ).toMatchObject({ contextWindow: 900000, useRecommendedConfig: false });
    await page.getByRole("switch", { name: "启用模型 deepseek-flash", exact: true }).uncheck();
    await expect(
      page.getByRole("switch", { name: "启用模型 deepseek-flash", exact: true }),
    ).not.toBeChecked();
    await page.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已获取");
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(
      page.getByRole("switch", { name: "启用模型 deepseek-flash", exact: true }),
    ).not.toBeChecked();
    await page.getByLabel("关闭设置", { exact: true }).click();
    await page.getByLabel("模型选择", { exact: true }).click();
    await expect(page.getByRole("menuitem", { name: "DeepSeek Flash", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.locator(".provider-list").getByRole("button", { name: "DeepSeek", exact: true }).click();
    await page.getByRole("switch", { name: "启用模型 deepseek-flash", exact: true }).check();
    await expect(page.getByRole("switch", { name: "启用模型 deepseek-flash", exact: true })).toBeChecked();
    await page.getByRole("switch", { name: "启用供应商 DeepSeek", exact: true }).uncheck();
    await expect(page.getByRole("switch", { name: "启用供应商 DeepSeek", exact: true })).not.toBeChecked();
    await page.getByRole("switch", { name: "启用供应商 DeepSeek", exact: true }).check();
    await expect(page.getByRole("switch", { name: "启用供应商 DeepSeek", exact: true })).toBeChecked();
    const beforeSave = await catalogCalls();
    await page.getByLabel("删除模型 deepseek-v4-pro", { exact: true }).click();
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已保存");
    await expect(page.locator(".provider-model-row")).toHaveCount(1);
    expect(await catalogCalls()).toBe(beforeSave);
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已保存");
    expect(await catalogCalls()).toBe(beforeSave);
    // Reopen and restart keep deletions; explicit refresh alone queries the catalog again.
    await page.getByLabel("关闭设置", { exact: true }).click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.locator(".provider-list").getByRole("button", { name: "DeepSeek", exact: true }).click();
    await expect(page.locator(".provider-model-row")).toHaveCount(1);
    await page.getByRole("button", { name: "获取模型", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已获取");
    expect(await catalogCalls()).toBe(beforeSave + 1);
    await expect(page.locator(".provider-model-row")).toHaveCount(2);
    await page.getByLabel("删除模型 deepseek-v4-pro", { exact: true }).click();
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已保存");
    await page.getByRole("button", { name: "新增提供商", exact: true }).click();
    await page.getByRole("button", { name: "自定义提供商", exact: true }).click();
    await page.getByLabel("提供商名称").fill("Local custom");
    await page.getByLabel("Base URL", { exact: true }).fill(server.url);
    await page.getByRole("button", { name: "新增模型", exact: true }).click();
    await page.getByRole("dialog").getByLabel("Model ID", { exact: true }).fill("custom-model");
    await page.getByRole("dialog").getByRole("button", { name: "保存", exact: true }).click();
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(
      page.locator(".provider-list").getByRole("button", { name: "Local custom", exact: true }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "保存提供商", exact: true })).toBeEnabled();
    const providers = page.locator(".sortable-provider");
    await expect(providers.last()).toBeEnabled();
    const initialIds = await providers.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-provider-id")),
    );
    const sourceProvider = await providers.last().boundingBox();
    const targetProvider = await providers.first().boundingBox();
    if (!sourceProvider || !targetProvider) throw Error("Missing providers");
    await page.mouse.move(sourceProvider.x + 50, sourceProvider.y + sourceProvider.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceProvider.x + 50, targetProvider.y + targetProvider.height / 2, { steps: 12 });
    await page.mouse.up();
    const expectedIds = [initialIds.at(-1), ...initialIds.slice(0, -1)];
    await expect
      .poll(async () => {
        const value = await page.evaluate(() => window.zpi.getSettings());
        return value.ok ? value.value.providers.map((p) => p.id) : [];
      })
      .toEqual(expectedIds);
    await page.screenshot({ path: "test-results/desktop-provider-order.png" });
    await page.getByRole("button", { name: "保存提供商", exact: true }).click();
    await expect(page.locator(".provider-editor .run-notice[role=status]")).toContainText("已保存");
    await expect(page.getByRole("alert")).toHaveCount(0);
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    const restartedPage = await app.firstWindow();
    const persisted = await restartedPage.evaluate(() => window.zpi.getSettings());
    if (!persisted.ok) throw Error(persisted.error.message);
    expect(persisted.value.providers.map((p) => p.id)).toEqual(expectedIds);
    expect(persisted.value.providers.find((p) => p.preset === "deepseek")?.models.map((m) => m.id)).toEqual([
      "deepseek-flash",
    ]);
    await restartedPage.getByRole("button", { name: "设置", exact: true }).click();
    await restartedPage.getByRole("button", { name: "模型", exact: true }).click();
    for (let i = 0; i < expectedIds.length; i++) {
      await restartedPage.getByLabel("供应商操作", { exact: true }).click();
      await restartedPage.getByRole("menuitem", { name: "删除", exact: true }).click();
      await restartedPage.getByRole("button", { name: "确认删除", exact: true }).click();
      await expect(restartedPage.locator(".sortable-provider")).toHaveCount(expectedIds.length - i - 1);
    }
    await expect(restartedPage.locator(".provider-template-grid button")).toHaveCount(9);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
