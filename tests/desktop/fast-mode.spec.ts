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
        name: "OpenAI（ChatGPT） · preview@example.test",
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
    const hint = page.locator('[role="tooltip"]:not([data-state="closed"])');
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    const fastKey = `${primary}+Shift+l`;
    const keyLabel = process.platform === "darwin" ? "⇧⌘L" : "Ctrl+Shift+L";
    await model.hover();
    await expect(hint).toHaveText(process.platform === "darwin" ? "切换模型⌘L" : "切换模型Ctrl+L");
    await editor.hover();
    await fast.hover();
    await expect(hint).toHaveText(`开启加速${keyLabel}`);
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    const offWidth = (await fast.boundingBox())?.width;
    await fast.click();
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await expect(editor).toBeFocused();
    expect((await fast.boundingBox())?.width).toBe(offWidth);
    await editor.fill("保留草稿");
    await editor.press(fastKey);
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await expect(fast).toBeEnabled();
    await editor.press(fastKey);
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await expect(fast).toBeEnabled();
    await expect(editor).toHaveText("保留草稿");
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await fast.hover();
    await expect(hint).toHaveText(`关闭加速${keyLabel}`);
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(async (theme) => {
        const result = await window.zpi.updatePreferences({ theme });
        if (!result.ok) throw new Error(result.error.message);
      }, theme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(fast).toHaveAttribute("aria-pressed", "true");
      await expect(fast).toHaveCSS("color", await model.evaluate((el) => getComputedStyle(el).color));
      await fast.hover();
      await expect(hint).toHaveCSS("opacity", "1");
      await page.screenshot({ path: `test-results/fast-mode-${theme}.png` });
    }
    await model.click();
    await expect(model).toHaveAttribute("aria-expanded", "true");
    await expect(model.locator(".lucide-chevron-up")).toBeVisible();
    await page.getByRole("menuitem", { name: "fake", exact: true }).hover();
    await page.getByRole("menuitem", { name: "高", exact: true }).click();
    await expect(model.locator(".lucide-chevron-down")).toBeVisible();
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
    await model.click();
    await expect(model.locator(".lucide-chevron-up")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(model.locator(".lucide-chevron-down")).toBeVisible();
    await expect(editor).toBeFocused();
    await page.evaluate(async () => {
      const current = await window.zpi.getSettings();
      if (!current.ok) throw new Error(current.error.message);
      const saved = await window.zpi.updateShortcuts({
        ...current.value.shortcuts,
        bindings: { ...current.value.shortcuts.bindings, "toggle-fast-mode": "CmdOrCtrl+Shift+B" },
      });
      if (!saved.ok) throw new Error(saved.error.message);
    });
    await page.reload();
    await editor.fill("remapped shortcut draft");
    await editor.press(fastKey);
    await expect(fast).toHaveAttribute("aria-pressed", "false");
    await editor.press(`${primary}+Shift+b`);
    await expect(fast).toHaveAttribute("aria-pressed", "true");
    await expect(editor).toHaveText("remapped shortcut draft");
    await expect(page.getByTestId("run")).toHaveCount(2);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
