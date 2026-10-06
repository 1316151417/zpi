import { presetModels } from "ZPI-ai";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("GPT models offer five or six efforts with medium default; Chinese models show only their controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-efforts-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  const app = await launchDesktop({ dir, url: server.url });
  try {
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ url, modelsJson }) => {
        const result = await window.ZPI.saveProvider({
          id: "efforts",
          name: "档位测试",
          baseUrl: url,
          apiKey: "fake",
          models: JSON.parse(modelsJson),
        });
        if (!result.ok) throw new Error(result.error.message);
      },
      {
        url: server.url,
        modelsJson: JSON.stringify([
          ...presetModels("openai-chatgpt"),
          ...presetModels("deepseek"),
          ...presetModels("mimo-api"),
        ]),
      },
    );
    await page.reload();
    const openModel = async (name: string) => {
      await page.getByLabel("模型选择", { exact: true }).click();
      await page.getByRole("menuitem", { name, exact: true }).hover();
    };
    const efforts = () =>
      page.getByRole("menuitem").filter({ hasText: /^(关闭|低|中|高|极高|最高)( · 默认)?$/ });
    const editor = page.getByLabel("消息", { exact: true });
    const modelButton = page.getByLabel("模型选择", { exact: true });
    await modelButton.click();
    await page.getByRole("menuitem", { name: "GPT-6.1 Sol", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(modelButton).toHaveText("GPT-6.1 Sol中");
    await openModel("GPT-6.1 Sol");
    await expect(efforts()).toHaveText(["低", "中 · 默认", "高", "极高", "最高"]);
    await expect(modelButton).toHaveText("GPT-6.1 Sol中");
    await page.screenshot({ path: "test-results/gpt-reasoning-levels.png" });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    await editor.fill("medium");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(1);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.reasoning_effort).toBe("medium");
    await openModel("GPT-6 Astra");
    await expect(efforts()).toHaveText(["低", "中 · 默认", "高", "极高", "最高"]);
    await expect(modelButton).toHaveText("GPT-6.1 Sol中");
    await page.getByRole("menuitem", { name: "极高", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(page.getByLabel("模型选择", { exact: true })).toContainText("极高");
    await editor.fill("xhigh");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.reasoning_effort).toBe("xhigh");
    await modelButton.click();
    await page.getByRole("menuitem", { name: "GPT-6 Astra", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(modelButton).toHaveText("GPT-6 Astra中");
    await page.reload();
    await expect(modelButton).toHaveText("GPT-6 Astra中");
    await openModel("GPT-6 Luna");
    await expect(efforts()).toHaveText(["关闭", "低", "中 · 默认", "高", "极高", "最高"]);
    await page.getByRole("menuitem", { name: "最高", exact: true }).click();
    await expect(page.getByLabel("模型选择", { exact: true })).toContainText("最高");
    await editor.fill("max");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(3);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.reasoning_effort).toBe("max");
    await page.reload();
    await expect(page.getByLabel("模型选择", { exact: true })).toContainText("最高");
    await openModel(presetModels("deepseek")[0].name ?? "deepseek-flash");
    await expect(efforts()).toHaveText(["关闭", "低", "高", "最高"]);
    await page.getByRole("menuitem", { name: "高", exact: true }).click();
    await openModel(presetModels("mimo-api")[0].name ?? "mimo-v2.5");
    await expect(page.getByRole("menuitem", { name: "关闭", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: "默认", exact: true })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /^(中|极高|最高)$/ })).toHaveCount(0);
  } finally {
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
