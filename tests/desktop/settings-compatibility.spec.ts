import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { launchDesktop } from "../helpers/desktop.ts";

for (const fontSize of [14, 17]) {
  test(`desktop preserves ${fontSize}px settings and the archived tab shares the new settings frame`, async () => {
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
        fontSize,
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
      expect(settings.interface.fontSize).toBe(fontSize);
      expect(settings.interface.sidebarWidth).toBe(200);
      expect(await readFile(file, "utf8")).toBe(raw);
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "系统提示词", exact: true }).click();
      await expect(page.locator(".system-rules-preview")).toContainText("Return web URLs as Markdown links");
      const archivesTab = page.getByRole("button", { name: "已归档任务", exact: true });
      await archivesTab.click();
      await expect(archivesTab).toHaveCSS("font-size", `${fontSize}px`);
      await expect(page.locator(".settings-screen h1")).toHaveCount(1);
      await expect(page.getByRole("heading", { name: "已归档任务", exact: true })).toBeVisible();
      await expect(page.locator(".settings-main")).toHaveCSS("border-radius", "12px");
      await expect(page.locator(".settings-screen")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(page.locator(".settings-titlebar")).toHaveCSS("app-region", "drag");
      await page.getByRole("button", { name: "界面设置", exact: true }).click();
      const size = page.getByRole("spinbutton", { name: "界面字号", exact: true });
      await expect(size).toHaveValue(`${fontSize}`);
      await size.fill("16");
      await size.press("Tab");
      await archivesTab.click();
      await expect(archivesTab).toHaveCSS("font-size", "16px");
      await expect(page.getByRole("heading", { name: "已归档任务", exact: true })).toBeVisible();
    } finally {
      await app?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
