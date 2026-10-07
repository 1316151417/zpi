import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("packaged terminal starts a shell and runs commands outside the repository", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-packaged-terminal-"));
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
    await input.pressSequentially("printf 'PACKAGED_%s\\n' 'TERMINAL_OK'; pwd", { delay: 1 });
    await input.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("PACKAGED_TERMINAL_OK");
    await expect(page.locator(".xterm-rows")).toContainText(join(dir, "workspace"));
    await page.getByLabel("关闭标签 zsh", { exact: true }).click();
    await expect(page.locator(".xterm-helper-textarea")).toHaveCount(0);
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
