import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("packaged terminal starts a shell and runs commands outside the repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-packaged-terminal-"));
  await writeFile(join(dir, ".zshrc"), "PROMPT='ZPI> '\n");
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "", packaged: true });
    const page = await app.firstWindow();
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "终端", exact: true }).click();
    const input = page.locator(".right-pane .xterm-helper-textarea");
    await expect(input).toBeAttached();
    await expect(page.locator(".terminal-cwd")).toHaveCount(0);
    const terminalClose = page.getByLabel(/^关闭标签 draft-/);
    await expect(terminalClose).toBeVisible();
    await expect(page.getByTestId("terminal-surface")).toHaveCSS("padding", "12px");
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "13px");
    await input.pressSequentially("printf 'PACKAGED_%s\\n' 'TERMINAL_OK'; pwd", { delay: 1 });
    await input.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("PACKAGED_TERMINAL_OK");
    await expect(page.locator(".xterm-rows")).toContainText(join(dir, "workspace"));
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
      document.documentElement.style.setProperty("--ui-font-size", "18px");
    });
    await expect(page.locator(".xterm-rows")).toHaveCSS("font-size", "13px");
    await expect(page.locator(".xterm-viewport")).toHaveCSS("background-color", "rgb(22, 22, 22)");
    await expect(page.locator(".xterm-rows")).toContainText("PACKAGED_TERMINAL_OK");
    await input.pressSequentially("printf 'THEME_%s\\n' 'INPUT_OK'", { delay: 1 });
    await input.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("THEME_INPUT_OK");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
      document.documentElement.style.removeProperty("--ui-font-size");
    });
    await expect(page.locator(".xterm-viewport")).toHaveCSS("background-color", "rgb(248, 248, 248)");
    await terminalClose.click();
    await expect(page.locator(".xterm-helper-textarea")).toHaveCount(0);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
