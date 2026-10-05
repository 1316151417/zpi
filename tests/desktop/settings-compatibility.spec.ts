import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

test("desktop starts with previously saved numeric font settings", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-settings-compatibility-"));
  const file = join(dir, "settings.json");
  const raw = JSON.stringify({
    version: 4,
    templates: [],
    selectedTemplateId: "pi",
    disabledSkillPaths: [],
    providers: [],
    lastSelection: null,
    interface: {
      theme: "system",
      fontSize: 14,
      showContextUsage: false,
      showSendButton: false,
      sidebarCollapsed: false,
      sidebarWidth: 200,
      collapsedProjectIds: [],
      projectsCollapsed: false,
      tasksCollapsed: false,
    },
  });
  await writeFile(file, raw);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect(page.getByRole("button", { name: "设置", exact: true })).toBeVisible();
    const settings = await page.evaluate(async () => {
      const result = await window.zpi.getSettings();
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    expect(settings.interface.fontSize).toBe("default");
    expect(settings.interface.sidebarWidth).toBe(200);
    expect(await readFile(file, "utf8")).toBe(raw);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "系统提示词", exact: true }).click();
    await expect(page.locator(".system-rules-preview")).toContainText("Return web URLs as Markdown links");
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
