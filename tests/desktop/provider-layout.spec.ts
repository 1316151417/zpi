import { providerBaseUrl } from "ZPI-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

async function expectAlignedFields(page: Page, count: number) {
  const fields = await page.locator(".provider-connection-fields").evaluate((element) =>
    Array.from(element.children).map((field) => {
      const label = field.querySelector(":scope > span:not(.credential-input), :scope > label");
      const control = field.querySelector("input, [role=combobox]");
      if (!label || !control) throw new Error("Missing provider field label or control");
      const caption = label.getBoundingClientRect();
      const input = control.getBoundingClientRect();
      return {
        top: caption.top,
        bottom: input.bottom,
        labelGap: input.top - caption.bottom,
        height: input.height,
        width: input.width,
        left: input.left,
      };
    }),
  );
  expect(fields).toHaveLength(count);
  for (const field of fields) {
    expect(field.labelGap).toBeGreaterThan(0);
    expect(field.labelGap).toBeLessThan(8);
    expect(field.height).toBe(fields[0].height);
    expect(field.width).toBe(fields[0].width);
    expect(field.left).toBe(fields[0].left);
    expect(field.labelGap).toBe(fields[0].labelGap);
  }
  const gaps = fields.slice(1).map((field, index) => field.top - fields[index].bottom);
  expect(Math.max(...gaps) - Math.min(...gaps)).toBeLessThan(1);
  const eyeOffset = await page.locator(".credential-input").evaluate((element) => {
    const control = element.querySelector("input")?.getBoundingClientRect();
    const button = element.querySelector("button")?.getBoundingClientRect();
    if (!control || !button) throw new Error("Missing credential visibility control");
    return Math.abs(control.top + control.height / 2 - button.top - button.height / 2);
  });
  expect(eyeOffset).toBeLessThan(1);
}

for (const theme of ["light", "dark"] as const) {
  test(`provider forms align fields, empty models and feedback in ${theme} mode`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ZPI-provider-layout-"));
    const app = await launchDesktop({ dir, url: "" });
    try {
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme: theme });
      await page.evaluate(async (baseUrl) => {
        const result = await window.ZPI.saveProvider({
          id: "layout-preset",
          preset: "zhipu-coding",
          name: "智谱（Coding Plan）",
          api: "anthropic-messages",
          baseUrl,
          apiKey: "local-layout-key",
          models: ["glm-5.3", "glm-5.3-flash"].map((id) => ({ id, reasoning: false })),
        });
        if (!result.ok) throw new Error(result.error.message);
      }, providerBaseUrl("zhipu-coding"));
      await page.reload();
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "模型", exact: true }).click();
      await page.mouse.move(1100, 20);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
      await expectAlignedFields(page, 3);
      await expect(page.locator(".provider-model-row")).toHaveCount(2);
      await page.screenshot({ path: `test-results/provider-layout-preset-${theme}.png` });

      await page.getByRole("button", { name: "新增提供商", exact: true }).click();
      await page
        .locator(".provider-template-grid")
        .getByRole("button", { name: "自定义提供商", exact: true })
        .click();
      await expectAlignedFields(page, 4);
      await expect(page.locator(".provider-model-empty")).toContainText("暂无模型");
      await page.getByRole("combobox", { name: "API 格式", exact: true }).click();
      await page.getByRole("option", { name: /OpenAI Chat Completions/ }).click();
      await expectAlignedFields(page, 4);
      const footer = page.locator(".provider-footer");
      await expect(footer.getByRole("status")).toBeVisible();
      await expect(footer.getByRole("button", { name: "保存提供商", exact: true })).toBeVisible();
      await page.screenshot({ path: `test-results/provider-layout-custom-${theme}.png` });

      await page.setViewportSize({ width: 900, height: 720 });
      await expectAlignedFields(page, 4);
      await expect(page.locator(".provider-model-empty")).toBeVisible();
      await expect(footer.getByRole("button", { name: "保存提供商", exact: true })).toBeVisible();
      expect(
        await page
          .locator(".provider-details")
          .evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeLessThan(1);
    } finally {
      await app.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
