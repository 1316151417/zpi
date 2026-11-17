import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { StateStore } from "../../packages/desktop/src/main/state-store.ts";
import { SettingsStore } from "../../packages/desktop/src/main/storage.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { testStorageDirectory } from "../helpers/storage.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("startup archiving waits for the current task to be restored before cleaning older tasks", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-auto-archive-startup-")));
  const current = seedHistory(dir, dir, 1, {
    createdAt: Date.now() - 40 * 86400000,
    updatedAt: Date.now() - 40 * 86400000,
  });
  const older = seedHistory(dir, dir, 1, {
    createdAt: Date.now() - 50 * 86400000,
    updatedAt: Date.now() - 50 * 86400000,
  });
  const settings = new SettingsStore(testStorageDirectory(dir), {
    isEncryptionAvailable: () => false,
    encryptString: () => Buffer.alloc(0),
    decryptString: () => "",
  });
  try {
    settings.updateAutoArchive({ enabled: true, olderThanDays: 7 });
  } finally {
    settings.close();
  }
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await window.zpi.listArchivedSessions();
          if (!result.ok) throw new Error(result.error.message);
          return result.value.map((record) => record.id);
        }),
      )
      .toEqual([older.id]);
    await expect(page.locator(`[data-testid="session-row"][data-session-id="${current.id}"]`)).toBeVisible();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("archive settings persist and manual scan archives old tasks while automatic archiving is off", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-auto-archive-")));
  const old = seedHistory(dir, dir, 1, {
    createdAt: Date.now() - 10 * 86400000,
    updatedAt: Date.now() - 10 * 86400000,
  });
  seedHistory(dir, dir, 1);
  const state = new StateStore(join(testStorageDirectory(dir), "state.sqlite"));
  try {
    const task = state.getTask(old.id);
    if (!task) throw new Error("Missing seeded task");
    state.upsertTask({ ...task, title: "手动归档历史任务" });
  } finally {
    state.close();
  }
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const openArchives = async () => {
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "已归档任务", exact: true }).click();
    };
    const policy = () =>
      page.evaluate(async () => {
        const result = await window.zpi.getSettings();
        if (!result.ok) throw new Error(result.error.message);
        return result.value.autoArchive;
      });
    await openArchives();
    const toggle = page.getByRole("switch", { name: "自动归档旧会话", exact: true });
    await expect(page.locator(".auto-archive-row p, .auto-archive-notes")).toHaveCount(0);
    for (const [label, description] of [
      ["归档管理", "在原路径按原分支和提交重建 worktree"],
      ["自动归档旧会话", "软件启动并恢复当前任务后"],
      ["归档保留时长", "会话最后更新时间早于该时长后"],
      ["手动归档", "无需开启自动归档"],
    ]) {
      await page.getByRole("button", { name: `${label}说明`, exact: true }).focus();
      await expect(page.getByRole("tooltip").filter({ hasText: description })).toBeVisible();
    }
    await toggle.focus();
    await expect(page.getByRole("tooltip")).toHaveCount(0);
    await expect(toggle).not.toBeChecked();
    expect(await policy()).toEqual({ enabled: false, olderThanDays: 30 });
    await page.getByRole("combobox", { name: "归档保留时长", exact: true }).click();
    await page.getByRole("option", { name: "7 天后归档", exact: true }).click();
    await expect.poll(policy).toEqual({ enabled: false, olderThanDays: 7 });
    await expect(page.getByRole("button", { name: "立即归档", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "立即归档", exact: true }).click();
    await expect(page.locator(".auto-archive-result")).toContainText("已归档 1 个任务，跳过 0 个任务。");
    await expect(page.locator(`.archived-row[data-session-id="${old.id}"]`)).toContainText(
      "手动归档历史任务",
    );
    await expect(toggle).not.toBeChecked();
    const archived = await page.evaluate(async () => {
      const result = await window.zpi.listArchivedSessions();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.map((record) => record.id);
    });
    expect(archived).toContain(old.id);
    await toggle.click();
    await expect.poll(policy).toEqual({ enabled: true, olderThanDays: 7 });
    await page.reload();
    await openArchives();
    await expect(toggle).toBeChecked();
    await expect(page.getByRole("combobox", { name: "归档保留时长", exact: true })).toContainText(
      "7 天后归档",
    );
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "light" }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page
      .locator(".auto-archive-settings")
      .screenshot({ path: test.info().outputPath("auto-archive-light.png"), animations: "disabled" });
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "dark" }));
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page
      .locator(".auto-archive-settings")
      .screenshot({ path: test.info().outputPath("auto-archive-dark.png"), animations: "disabled" });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setMinimumSize(400, 600);
      window.setSize(600, 800);
    });
    await expect(page.locator(".auto-archive-row").first()).toHaveCSS(
      "grid-template-columns",
      /^\d+(?:\.\d+)?px$/,
    );
    await page
      .locator(".auto-archive-settings")
      .screenshot({ path: test.info().outputPath("auto-archive-narrow.png"), animations: "disabled" });
    const overflow = await page
      .locator(".auto-archive-card")
      .evaluate((card) => card.scrollWidth > card.clientWidth);
    expect(overflow).toBe(false);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
