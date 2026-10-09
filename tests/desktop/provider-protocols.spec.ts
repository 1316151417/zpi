import { providerBaseUrl, providerPresets } from "ZPI-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("preset connection protocol changes update endpoints, preserve keys and survive restarting", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-provider-protocol-ui-"));
  let app = await launchDesktop({ dir, url: "" });
  const presets = providerPresets.filter((preset) => preset.id !== "openai-chatgpt");
  try {
    let page = await app.firstWindow();
    await page.evaluate(async (presets) => {
      for (const preset of presets) {
        const result = await window.ZPI.saveProvider({
          id: preset.id,
          preset: preset.id,
          name: preset.name,
          baseUrl: preset.baseUrl,
          apiKey: "local-test-key",
          models: [{ id: "model", reasoning: false, contextWindow: 32768, maxTokens: 4096 }],
        });
        if (!result.ok) throw new Error(result.error.message);
      }
    }, presets);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page.getByRole("button", { name: "新增提供商", exact: true }).click();
    await page
      .locator(".provider-template-grid")
      .getByRole("button", { name: "DeepSeek", exact: true })
      .click();
    await expect(page.getByRole("combobox", { name: "API 格式", exact: true })).toContainText(
      "Anthropic Messages",
    );
    await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue(providerBaseUrl("deepseek"));
    for (const [index, preset] of presets.entries()) {
      await page.locator(".provider-list").getByRole("button", { name: preset.name, exact: true }).click();
      const select = page.getByRole("combobox", { name: "API 格式", exact: true });
      await expect(select).toContainText("OpenAI Chat Completions");
      await expect(select).toBeEnabled();
      await select.click();
      await expect(page.getByRole("option", { name: /Anthropic Messages/ })).toBeVisible();
      await expect(page.getByRole("option", { name: /OpenAI Responses/ })).toHaveCount(0);
      if (index === 0) {
        await page.screenshot({ path: "test-results/provider-protocol-light.png" });
        await page.emulateMedia({ colorScheme: "dark" });
        await page.screenshot({ path: "test-results/provider-protocol-dark.png" });
        await page.emulateMedia({ colorScheme: "light" });
      }
      await page.getByRole("option", { name: /Anthropic Messages/ }).click();
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue(providerBaseUrl(preset.id));
      await page.getByRole("button", { name: "保存提供商", exact: true }).click();
      await expect(page.locator(".provider-footer").getByRole("status")).toHaveText("提供商已保存。");
      const saved = await page.evaluate(async (id) => {
        const result = await window.ZPI.getProviderCredentials(id);
        if (!result.ok) throw new Error(result.error.message);
        return result.value;
      }, preset.id);
      expect(saved.apiKey).toBe("local-test-key");
    }
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    for (const preset of presets) {
      await page.locator(".provider-list").getByRole("button", { name: preset.name, exact: true }).click();
      await expect(page.getByRole("combobox", { name: "API 格式", exact: true })).toContainText(
        "Anthropic Messages",
      );
      await expect(page.getByLabel("Base URL", { exact: true })).toHaveValue(providerBaseUrl(preset.id));
    }
    await page.getByRole("button", { name: "新增提供商", exact: true }).click();
    await page
      .locator(".provider-template-grid")
      .getByRole("button", { name: "自定义提供商", exact: true })
      .click();
    await page.getByRole("combobox", { name: "API 格式", exact: true }).click();
    await expect(page.getByRole("option", { name: /OpenAI Responses/ })).toBeVisible();
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
