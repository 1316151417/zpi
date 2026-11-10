import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("composer lightning toggles a durable per-session speed, preserves reasoning changes and hides on unsupported models", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-fast-mode-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "加速模式", exact: true })).toHaveCount(0);
    await page.evaluate(async () => {
      const settings = await window.zpi.getSettings();
      if (!settings.ok) throw new Error(settings.error.message);
      const provider = settings.value.providers[0];
      const result = await window.zpi.saveProvider({
        id: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        ...(provider.api ? { api: provider.api } : {}),
        apiKey: "isolated-key",
        models: [
          ...provider.models.map((model) => ({ ...model, serviceTiers: ["priority"] })),
          { id: "standard-only", name: "Standard only", reasoning: false },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
    });
    await page.reload();
    const fast = page.getByRole("button", { name: "加速模式", exact: true });
    const model = page.getByLabel("模型选择", { exact: true });
    const editor = page.getByLabel("消息", { exact: true });
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    const offWidth = (await fast.boundingBox())?.width;
    await fast.click();
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await expect(editor).toBeFocused();
    expect((await fast.boundingBox())?.width).toBe(offWidth);
    await editor.hover();
    await fast.hover();
    await expect(page.getByRole("tooltip")).toContainText("API 费用更高");
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(async (theme) => {
        const result = await window.zpi.updatePreferences({ theme });
        if (!result.ok) throw new Error(result.error.message);
      }, theme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(fast).toHaveAttribute("aria-pressed", "true");
      await expect(fast).toHaveCSS("color", theme === "dark" ? "rgb(227, 196, 119)" : "rgb(118, 87, 22)");
      await fast.hover();
      await expect(page.getByRole("tooltip")).toHaveCSS("opacity", "1");
      await page.screenshot({ path: `test-results/fast-mode-${theme}.png` });
    }
    await model.click();
    await page.getByRole("menuitem", { name: "fake", exact: true }).hover();
    await page.getByRole("menuitem", { name: "高", exact: true }).click();
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await editor.fill("fast request");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(1);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.service_tier).toBe("priority");
    await fast.click();
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await editor.fill("standard request");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.service_tier).toBe("default");
    await fast.click();
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await model.click();
    await page.getByRole("menuitem", { name: "Standard only", exact: true }).click();
    await expect(fast).toHaveCount(0);
    await model.click();
    await page.getByRole("menuitem", { name: "fake", exact: true }).click();
    await expect(fast).toHaveAttribute("aria-pressed", "false");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
