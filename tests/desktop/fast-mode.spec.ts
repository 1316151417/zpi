import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("model menu acceleration stays open, persists, and shares its action with the focused composer's shortcut", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-fast-mode-"));
  const project = join(dir, "project");
  await mkdir(project);
  const screenshots = process.env.ZPI_FAST_MODE_SCREENSHOTS;
  if (screenshots) await mkdir(screenshots, { recursive: true });
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.evaluate(async () => {
      const settings = await window.zpi.getSettings();
      if (!settings.ok) throw new Error(settings.error.message);
      const provider = settings.value.providers[0];
      const result = await window.zpi.saveProvider({
        id: provider.id,
        name: "OpenAI（API）",
        baseUrl: provider.baseUrl,
        ...(provider.api ? { api: provider.api } : {}),
        apiKey: "isolated-key",
        models: [
          ...provider.models.map((model) => ({ ...model, name: "GPT-6.1 Sol", serviceTiers: ["priority"] })),
          { id: "standard-only", name: "GPT-6 Luna", reasoning: false, serviceTiers: [] },
        ],
      });
      if (!result.ok) throw new Error(result.error.message);
      const prefs = await window.zpi.updatePreferences({ theme: "light" });
      if (!prefs.ok) throw new Error(prefs.error.message);
    });
    // Present OpenAI's provider identity to the renderer while retaining the isolated loopback transport.
    await app.evaluate(({ ipcMain }) => {
      const presentation: { preset?: string } = { preset: "openai-api" };
      Object.assign(globalThis, { fastModePresentation: presentation });
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, method: string, args: unknown[]) => Promise<unknown>>;
      };
      const original = internal._invokeHandlers.get("zpi:call");
      if (!original) throw new Error("Missing IPC handler");
      ipcMain.removeHandler("zpi:call");
      ipcMain.handle("zpi:call", async (event, method, args) => {
        const result = await original(event, method, args);
        if (method === "getSettings") {
          const settings = result as {
            ok: boolean;
            value?: {
              providers: {
                id: string;
                name: string;
                preset?: string;
                chatgptAccount?: { label: string; connected: boolean };
              }[];
            };
          };
          const provider = settings.value?.providers.find((entry) => entry.id === "custom");
          if (settings.ok && provider) {
            provider.preset = presentation.preset;
            if (presentation.preset === "openai-chatgpt") {
              provider.name = "OpenAI（ChatGPT） · zhoujie19960911@gmail.com";
              provider.chatgptAccount = {
                label: "zhoujie19960911@gmail.com · test-account",
                connected: true,
              };
            }
          }
        }
        return result;
      });
    });
    await page.reload();
    const main = page.locator("main");
    const model = main.getByLabel("模型选择", { exact: true });
    const editor = main.getByLabel("消息", { exact: true });
    const indicator = model.getByRole("img", { name: "加速已开启", exact: true });
    const fast = page.getByRole("menuitemcheckbox", { name: "加速", exact: true });
    const hint = page.locator('[role="tooltip"]:not([data-state="closed"])');
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    const fastKey = `${primary}+Shift+l`;
    const keyLabel = process.platform === "darwin" ? "⇧⌘L" : "Ctrl+Shift+L";
    const capture = async (name: string, includeMenu = false, includeHint = false) => {
      if (!screenshots) return;
      if (!includeHint) {
        await page.mouse.move(0, 0);
        await expect(page.getByRole("tooltip")).toHaveCount(0);
      }
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
      );
      const composer = await main.locator(".composer").boundingBox();
      const menu = includeMenu ? await page.locator(".model-menu").boundingBox() : undefined;
      const tooltip = includeHint ? await hint.boundingBox() : undefined;
      if (!composer || (includeMenu && !menu)) throw new Error("Missing screenshot surface");
      const right = composer.x + composer.width + 12;
      const bottom = composer.y + composer.height + 12;
      const x = Math.max(0, Math.min(menu ? menu.x - 12 : right - 460, tooltip ? tooltip.x - 12 : right));
      const y = Math.max(0, Math.min(menu ? menu.y : bottom - 140, tooltip ? tooltip.y - 8 : bottom));
      await page.screenshot({
        path: join(screenshots, `${name}.png`),
        clip: { x, y, width: right - x, height: bottom - y },
        animations: "disabled",
      });
    };
    const setFromMenu = async (enabled: boolean) => {
      await model.click();
      await expect(fast).toBeVisible();
      if ((await fast.getAttribute("aria-checked")) !== String(enabled)) await fast.click();
      await expect(fast).toHaveAttribute("aria-checked", String(enabled));
      await expect(fast).toBeEnabled();
      await expect(model).toHaveAttribute("aria-expanded", "true");
      await page.mouse.move(0, 0);
      await expect(page.getByRole("tooltip")).toHaveCount(0);
    };

    await expect(page.getByRole("button", { name: "加速模式", exact: true })).toHaveCount(0);
    await expect(indicator).toHaveCount(0);
    await model.hover();
    await expect(hint).toHaveText(process.platform === "darwin" ? "切换模型⌘L" : "切换模型Ctrl+L");
    await model.click();
    await expect(model.locator(".lucide-chevron-up")).toBeVisible();
    await page.getByRole("menuitem", { name: "GPT-6.1 Sol", exact: true }).hover();
    await page.getByRole("menuitem", { name: "高", exact: true }).click();
    await expect(model.locator(".lucide-chevron-down")).toBeVisible();
    await capture("composer-off");

    await setFromMenu(false);
    await expect(page.locator(".model-provider-heading").filter({ has: fast })).toContainText("OpenAI");
    await expect(fast).toHaveText("");
    await expect(fast.locator("svg")).toHaveAttribute("fill", "none");
    await expect(page.locator(".model-menu kbd, .model-menu .environment-switch")).toHaveCount(0);
    await capture("menu-off", true);
    const idleBackground = await fast.evaluate((el) => getComputedStyle(el).backgroundColor);
    await fast.hover();
    await expect(hint).toHaveText(`开启加速${keyLabel}`);
    await expect(fast).not.toHaveCSS("background-color", idleBackground);
    await fast.click();
    await expect(fast).toHaveAttribute("aria-checked", "true");
    await expect(fast.locator("svg")).toHaveAttribute("fill", "currentColor");
    await expect(fast).toBeEnabled();
    await expect(page.locator(".model-menu")).toBeVisible();
    await capture("menu-on", true);
    await fast.hover();
    await expect(hint).toHaveText(`关闭加速${keyLabel}`);
    await capture("menu-hover", true, true);
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(editor).toBeFocused();
    await expect(indicator).toBeVisible();
    await capture("composer-on");

    await editor.fill("保留草稿");
    await editor.press(fastKey);
    await expect(indicator).toHaveCount(0);
    await expect(model).toBeEnabled();
    await editor.press(fastKey);
    await expect(indicator).toBeVisible();
    await expect(model).toBeEnabled();
    await expect(editor).toHaveText("保留草稿");
    for (const theme of ["dark", "light"] as const) {
      await page.evaluate(async (theme) => {
        const result = await window.zpi.updatePreferences({ theme });
        if (!result.ok) throw new Error(result.error.message);
      }, theme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveCSS("color", await model.evaluate((el) => getComputedStyle(el).color));
      await model.click();
      await expect(fast).toHaveAttribute("aria-checked", "true");
      if (theme === "dark") await capture("menu-dark", true);
      await page.keyboard.press("Escape");
    }
    await model.click();
    await page.getByRole("menuitem", { name: "GPT-6.1 Sol", exact: true }).hover();
    await page.getByRole("menuitem", { name: "中", exact: true }).click();
    await expect(indicator).toBeVisible();
    await editor.fill("fast request");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(1);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.service_tier).toBe("priority");
    await setFromMenu(false);
    await page.keyboard.press("Escape");
    await expect(indicator).toHaveCount(0);
    await editor.fill("standard request");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests.at(-1)?.service_tier).toBe("default");
    await setFromMenu(true);
    await page.getByRole("menuitem", { name: "GPT-6 Luna", exact: true }).click();
    await expect(indicator).toHaveCount(0);
    await model.click();
    await expect(fast).toHaveCount(0);
    await page.keyboard.press("Escape");
    await editor.fill("unsupported draft");
    await editor.press(fastKey);
    await expect(indicator).toHaveCount(0);
    await expect(editor).toHaveText("unsupported draft");
    await model.click();
    await page.getByRole("menuitem", { name: "GPT-6.1 Sol", exact: true }).click();
    await expect(indicator).toHaveCount(0);
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
    await expect(indicator).toHaveCount(0);
    await editor.press(`${primary}+Shift+b`);
    await expect(indicator).toBeVisible();
    await expect(editor).toHaveText("remapped shortcut draft");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await model.click();
    await expect(fast).toHaveAttribute("aria-checked", "true");
    await fast.hover();
    await expect(hint).toHaveText(process.platform === "darwin" ? "关闭加速⇧⌘B" : "关闭加速Ctrl+Shift+B");
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.locator(".side-chat-pane");
    const sideModel = side.getByLabel("模型选择", { exact: true });
    await expect(sideModel).toContainText("GPT-6.1 Sol");
    const sideIndicator = sideModel.getByRole("img", { name: "加速已开启", exact: true });
    const sideWasOn = (await sideIndicator.count()) > 0;
    const sideEditor = side.getByLabel("消息", { exact: true });
    await sideEditor.fill("side shortcut draft");
    await sideEditor.press(`${primary}+Shift+b`);
    await expect(sideIndicator).toHaveCount(sideWasOn ? 0 : 1);
    await expect(indicator).toBeVisible();
    await expect(editor).toHaveText("remapped shortcut draft");
    await expect(sideEditor).toHaveText("side shortcut draft");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await app.evaluate(() => {
      (globalThis as unknown as { fastModePresentation: { preset?: string } }).fastModePresentation.preset =
        "openai-chatgpt";
    });
    await page.reload();
    await model.click();
    await expect(page.locator(".model-provider-label")).toHaveText("OpenAI · zhouji***@gmail");
    await expect(fast).toHaveAttribute("aria-checked", "true");
    await capture("subscription-on", true);
    await fast.click();
    await expect(fast).toHaveAttribute("aria-checked", "false");
    await expect(fast).toBeEnabled();
    await capture("subscription-off", true);
    await fast.hover();
    await expect(hint).toHaveText(process.platform === "darwin" ? "开启加速⇧⌘B" : "开启加速Ctrl+Shift+B");
    await capture("subscription-hover", true, true);
    await page.mouse.move(0, 0);
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await app.evaluate(() => {
      (globalThis as unknown as { fastModePresentation: { preset?: string } }).fastModePresentation.preset =
        undefined;
    });
    await page.reload();
    await model.click();
    await expect(fast).toHaveCount(0);
    await page.keyboard.press("Escape");
    await editor.fill("third-party priority model draft");
    await editor.press(`${primary}+Shift+b`);
    await expect(indicator).toHaveCount(0);
    await expect(editor).toHaveText("third-party priority model draft");
    await expect(page.getByTestId("run")).toHaveCount(2);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
