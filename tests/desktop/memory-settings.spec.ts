import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

async function openMemorySettings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "记忆", exact: true }).click();
  await expect(page.getByRole("region", { name: "记忆设置", exact: true })).toBeVisible();
  await expect(page.getByRole("switch", { name: "短记忆", exact: true })).toBeEnabled();
}

async function savedMemorySettings(page: Page) {
  return page.evaluate(async () => {
    const result = await window.zpi.getMemorySettings();
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  });
}

test("memory settings keep independent defaults, preview absent files safely and persist across restart", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-memory-settings-desktop-")));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "No model request is needed by this settings test." }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await openMemorySettings(page);
    const panel = page.getByRole("region", { name: "记忆设置", exact: true });
    const short = page.getByRole("switch", { name: "短记忆", exact: true });
    const long = page.getByRole("switch", { name: "长期记忆", exact: true });
    const generation = page.getByRole("switch", { name: "自动生成长期记忆", exact: true });
    await expect(short).not.toBeChecked();
    await expect(long).not.toBeChecked();
    await expect(generation).toBeChecked();
    await expect(panel).not.toContainText("/MEMORY.md");
    await expect(panel).not.toContainText("2,000");
    await expect(panel.locator(".memory-file")).toHaveCount(1);
    await page.getByRole("button", { name: "短记忆说明", exact: true }).hover();
    await expect(page.getByRole("tooltip")).toContainText("2,000");
    await expect(page.getByRole("tooltip")).toContainText("新对话首次发送时生效");
    await short.hover();

    const initial = await page.evaluate(async () => {
      const result = await window.zpi.getMemoryStatus(null);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    });
    expect(initial.shortFiles).toMatchObject([
      { scope: "user", path: join(dir, ".zpi", "MEMORY.md"), exists: false, count: 0, characters: 0 },
    ]);
    const userFile = initial.shortFiles[0].path;
    const view = panel.locator(".memory-file").getByRole("button", { name: "查看", exact: true });
    const viewStyle = await view.evaluate((button) => {
      const css = getComputedStyle(button);
      return {
        border: css.borderTopWidth,
        style: css.borderTopStyle,
        height: button.getBoundingClientRect().height,
      };
    });
    expect(viewStyle).toEqual({ border: "1px", style: "solid", height: 28 });
    await expect(stat(userFile)).rejects.toMatchObject({ code: "ENOENT" });
    await panel.locator(".memory-file").getByRole("button", { name: "查看", exact: true }).click();
    await expect(panel.locator(".memory-notice")).toHaveText("记忆文件尚未创建，可点击编辑添加内容。");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(stat(userFile)).rejects.toMatchObject({ code: "ENOENT" });
    await panel.getByRole("button", { name: "查看长期记忆", exact: true }).click();
    await expect(panel.locator(".memory-notice")).toHaveText("长期记忆尚未生成。");
    await expect(page.getByRole("dialog")).toHaveCount(0);

    const longFile = join(initial.long.path, "memory_summary.md");
    await mkdir(initial.long.path, { recursive: true });
    await writeFile(longFile, "# Long memory\n");
    await app.evaluate(({ app, nativeImage, shell }) => {
      app.getApplicationInfoForProtocol = async () => ({
        path: "/fake/editor.app",
        name: "Fake editor",
        icon: nativeImage.createEmpty(),
      });
      Object.assign(globalThis, { memoryOpenedPaths: [] as string[] });
      shell.openPath = async (path) => {
        (globalThis as unknown as { memoryOpenedPaths: string[] }).memoryOpenedPaths.push(path);
        return "";
      };
    });
    await panel.getByRole("button", { name: "查看长期记忆", exact: true }).click();
    await expect(panel.locator(".memory-notice")).toHaveText("已用默认程序打开长期记忆。");
    expect(
      await app.evaluate(() => (globalThis as unknown as { memoryOpenedPaths: string[] }).memoryOpenedPaths),
    ).toEqual([longFile]);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    const clearTrigger = panel.getByRole("button", { name: "清空长期记忆…", exact: true });
    await clearTrigger.click();
    const confirmation = page.getByRole("dialog", { name: "清空长期记忆？", exact: true });
    const cancel = confirmation.getByRole("button", { name: "取消", exact: true });
    await expect(cancel).toBeFocused();
    const sizes = await confirmation.locator("button").evaluateAll((buttons) =>
      buttons.map((button) => {
        const style = getComputedStyle(button);
        return { width: style.width, height: style.height };
      }),
    );
    expect(sizes).toEqual([
      { width: "72px", height: "32px" },
      { width: "72px", height: "32px" },
    ]);
    expect(
      await page
        .locator(".memory-dialog-backdrop")
        .evaluate((overlay) => Number(getComputedStyle(overlay).zIndex)),
    ).toBeGreaterThan(40);
    await page.screenshot({ path: "test-results/memory-clear-dialog.png", animations: "disabled" });
    await cancel.click();
    await expect(clearTrigger).toBeFocused();
    expect(await readFile(longFile, "utf8")).toBe("# Long memory\n");
    await clearTrigger.click();
    await confirmation.getByRole("button", { name: "清空", exact: true }).click();
    await expect(confirmation).toHaveCount(0);
    await expect(panel.locator(".memory-notice")).toHaveText("长期记忆已清空。");
    await expect(stat(longFile)).rejects.toMatchObject({ code: "ENOENT" });

    // Exercise all four combinations without sending a foreground or background model request.
    for (const [control, expected] of [
      [short, { short: true, long: false }],
      [long, { short: true, long: true }],
      [short, { short: false, long: true }],
      [long, { short: false, long: false }],
    ] as const) {
      await control.click();
      await expect.poll(() => savedMemorySettings(page)).toMatchObject(expected);
      await expect(control).toBeEnabled();
    }
    await short.click();
    await expect(short).toBeChecked();
    await expect(short).toBeEnabled();
    await long.click();
    await expect(long).toBeChecked();
    await expect(long).toBeEnabled();
    await generation.click();
    await expect(generation).not.toBeChecked();
    await expect(generation).toBeEnabled();
    await expect
      .poll(() => savedMemorySettings(page))
      .toMatchObject({ short: true, long: true, generate: false });
    await expect(panel.getByRole("button", { name: "立即检查更新", exact: true })).toBeDisabled();
    await expect(panel.locator(".memory-status")).toContainText("已暂停生成");

    await panel.locator("summary").filter({ hasText: "高级设置" }).click();
    const idle = page.getByRole("spinbutton", { name: "最少空闲小时", exact: true });
    await idle.fill("8");
    await idle.press("Tab");
    await expect.poll(() => savedMemorySettings(page)).toMatchObject({ minIdleHours: 8 });
    await expect(idle).toBeEnabled();
    const saved = await savedMemorySettings(page);
    await panel.locator("summary").filter({ hasText: "高级设置" }).click();
    await page.getByRole("region", { name: "记忆设置", exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/desktop-memory-settings.png" });
    await app.close();

    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await openMemorySettings(page);
    expect(await savedMemorySettings(page)).toEqual(saved);
    await expect(page.getByRole("switch", { name: "短记忆", exact: true })).toBeChecked();
    await expect(page.getByRole("switch", { name: "长期记忆", exact: true })).toBeChecked();
    await expect(page.getByRole("switch", { name: "自动生成长期记忆", exact: true })).not.toBeChecked();
    await expect(stat(userFile)).rejects.toMatchObject({ code: "ENOENT" });
    expect(server.requests).toHaveLength(0);
    expect(server.titleRequests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("project memory capacity diagnostics are visible and malformed memory IPC preserves saved settings", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-memory-diagnostics-desktop-")));
  const project = join(dir, "project");
  await mkdir(project);
  await mkdir(join(dir, ".zpi"));
  const userContent = "# Memory\n- [language] 使用中文。\n";
  const projectContent = `# Memory\n${Array.from({ length: 21 }, (_, index) => `- [fact-${index}] ${index === 0 ? "😀".repeat(2001) : "事实"}`).join("\n")}\n`;
  await writeFile(join(dir, ".zpi", "MEMORY.md"), userContent);
  await writeFile(join(project, "MEMORY.md"), projectContent);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "unused" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("zpi.selectedSession"))).toBeTruthy();
    const id = await page.evaluate(() => localStorage.getItem("zpi.selectedSession"));
    if (!id) throw new Error("Missing selected project session");
    await openMemorySettings(page);
    const projectRow = page.locator(".memory-file").filter({ hasText: "当前项目记忆" });
    await expect(projectRow).toContainText("文件异常，未自动加载");
    await expect(projectRow).not.toContainText("21 / 20 条");
    await expect(projectRow).not.toContainText(join(project, "MEMORY.md"));
    await projectRow.getByRole("button", { name: "查看", exact: true }).click();
    const preview = page.getByRole("dialog", { name: "记忆文件", exact: true });
    await expect(preview).toContainText("21 / 20 条");
    await expect(preview).toContainText("2,041 / 2,000 字符");
    await expect(preview).toContainText("记忆条数 21 超过上限 20");
    await expect(preview).toContainText(join(project, "MEMORY.md"));
    await page.getByRole("button", { name: "关闭记忆文件", exact: true }).click();
    const status = await page.evaluate(async (sessionId) => {
      const result = await window.zpi.getMemoryStatus(sessionId);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }, id);
    expect(status.shortFiles.map(({ scope }) => scope)).toEqual(["user", "project"]);
    expect(status.shortFiles[1]).toMatchObject({
      path: join(project, "MEMORY.md"),
      count: 21,
      characters: 2041,
    });
    expect(await readFile(join(project, "MEMORY.md"), "utf8")).toBe(projectContent);
    expect(await readFile(join(dir, ".zpi", "MEMORY.md"), "utf8")).toBe(userContent);

    const before = await savedMemorySettings(page);
    const rejected = await page.evaluate(async () => {
      const saved = await window.zpi.getMemorySettings();
      if (!saved.ok) throw new Error(saved.error.message);
      return [
        await window.zpi.saveMemorySettings({ ...saved.value, short: "yes" } as never),
        await window.zpi.saveMemorySettings({ ...saved.value, maxRolloutsPerBatch: 0 }),
        await window.zpi.saveMemorySettings({ ...saved.value, unexpected: true } as never),
        await window.zpi.getMemoryStatus(42 as never),
        await window.zpi.openMemoryFile(null, "unsupported" as never, "view"),
        await window.zpi.openMemoryFile(null, "project", "view"),
      ];
    });
    expect(rejected).toHaveLength(6);
    for (const result of rejected)
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    expect(await savedMemorySettings(page)).toEqual(before);
    expect(server.requests).toHaveLength(0);
    expect(server.titleRequests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
