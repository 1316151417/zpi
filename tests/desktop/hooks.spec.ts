import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

async function openHooks(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "钩子", exact: true }).click();
  await expect(page.getByRole("button", { name: "刷新钩子", exact: true })).toBeEnabled();
}
const script = (text: string) =>
  `process.stdout.write(JSON.stringify({additionalContext:${JSON.stringify(text)}}))`;
async function fillHook(page: Page, text: string) {
  await page.getByRole("combobox", { name: "触发事件", exact: true }).click();
  await page.getByRole("option", { name: "UserPromptSubmit", exact: true }).click();
  await page.getByLabel("可执行程序", { exact: true }).fill(process.execPath);
  await page.getByLabel("参数", { exact: true }).fill(`-e\n${script(text)}`);
}

for (const colorScheme of ["light", "dark"] as const) {
  test(`hooks settings create, execute, edit, disable and delete persisted hooks in ${colorScheme} mode`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-hook-settings-"));
    const server = await fakeServer((_, response) => {
      send(response, chunk({ content: "Hook configuration accepted." }));
      done(response);
    });
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, url: server.url });
      let page = await app.firstWindow();
      await page.emulateMedia({ colorScheme });
      await openHooks(page);
      const installed = () => page.getByRole("region", { name: "已安装钩子", exact: true });
      await expect(installed().getByRole("heading")).toHaveText("已安装 0");
      await expect(installed().getByText("尚未安装钩子", { exact: true })).toBeVisible();
      await expect(page.getByRole("region", { name: "会话标题钩子", exact: true })).toContainText(
        "InputAccepted",
      );
      await expect(page.locator(".hook-plugin-state").first()).toContainText("系统内置插件");
      for (const width of [1280, 800, 640]) {
        await page.setViewportSize({ width, height: 900 });
        expect(
          await page.locator(".hooks-settings").evaluate((panel) => panel.scrollWidth > panel.clientWidth),
        ).toBe(false);
        await expect(page.getByLabel("搜索钩子", { exact: true })).toBeVisible();
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: test.info().outputPath(`hooks-${colorScheme}.png`),
        animations: "disabled",
      });
      await page.getByLabel("搜索钩子", { exact: true }).fill("记忆策略");
      await expect(page.getByRole("region", { name: "记忆策略钩子", exact: true })).toBeVisible();
      await expect(installed()).toHaveCount(0);
      await expect(page.getByRole("region", { name: "会话标题钩子", exact: true })).toHaveCount(0);
      await page.getByLabel("搜索钩子", { exact: true }).fill("not-a-hook");
      await expect(installed()).toContainText("未找到匹配的钩子");
      await page.getByRole("button", { name: "新建", exact: true }).click();
      await fillHook(page, "HOOK_UI_CONTEXT");
      await page.getByText("高级设置", { exact: true }).click();
      await page.getByLabel("超时（秒）", { exact: true }).fill("5");
      await page.screenshot({
        path: test.info().outputPath(`hook-form-${colorScheme}.png`),
        animations: "disabled",
      });
      await page.getByRole("button", { name: "保存", exact: true }).click();
      const toggle = () => page.getByRole("switch", { name: "启用 UserPromptSubmit 钩子", exact: true });
      await expect(toggle()).toBeChecked();
      await page.getByRole("button", { name: "关闭设置", exact: true }).click();
      await page.getByLabel("消息", { exact: true }).fill("Use the configured hook");
      await page.getByLabel("发送", { exact: true }).click();
      await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
      expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("HOOK_UI_CONTEXT");
      await openHooks(page);
      await page.getByRole("button", { name: "编辑 UserPromptSubmit 钩子", exact: true }).click();
      await page.getByLabel("参数", { exact: true }).fill(`-e\n${script("UPDATED_HOOK")}`);
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await expect(installed()).toContainText("UPDATED_HOOK");
      await toggle().uncheck();
      await expect(toggle()).toBeEnabled();
      await expect(toggle()).not.toBeChecked();
      await app.close();
      app = await launchDesktop({ dir, url: server.url });
      page = await app.firstWindow();
      await page.emulateMedia({ colorScheme });
      await openHooks(page);
      await expect(toggle()).not.toBeChecked();
      await expect(installed()).toContainText("UPDATED_HOOK");
      await page.getByRole("button", { name: "编辑 UserPromptSubmit 钩子", exact: true }).click();
      await page.getByRole("button", { name: "删除", exact: true }).click();
      const confirmation = page.getByRole("dialog", { name: "删除钩子？", exact: true });
      await expect(confirmation.getByRole("button", { name: "取消", exact: true })).toBeFocused();
      await confirmation.getByRole("button", { name: "取消", exact: true }).click();
      await expect(page.getByRole("form", { name: "编辑钩子", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "删除", exact: true }).click();
      await confirmation.getByRole("button", { name: "删除", exact: true }).click();
      await expect(installed()).toContainText("尚未安装钩子");
      expect(server.requests).toHaveLength(1);
    } finally {
      await runCleanup([
        () => rm(dir, { recursive: true, force: true }),
        () => server.close(),
        () => app?.close(),
      ]);
    }
  });
}

test("hook scope targets the selected project and leaves its directory clean", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-hooks-scope-"));
  const project = join(dir, "hook-project");
  await mkdir(project);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: "" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await openHooks(page);
    const scope = page.getByRole("combobox", { name: "钩子范围", exact: true });
    await scope.click();
    await page.getByRole("option", { name: "本机 · hook-project", exact: true }).click();
    await expect(page.getByRole("button", { name: "刷新钩子", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "新建钩子", exact: true }).click();
    await fillHook(page, "PROJECT_ONLY_HOOK");
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByRole("region", { name: "已安装钩子", exact: true })).toContainText(
      "PROJECT_ONLY_HOOK",
    );
    await scope.click();
    await page.getByRole("option", { name: "本机 · 用户", exact: true }).click();
    await expect(page.getByRole("region", { name: "已安装钩子", exact: true })).toContainText("尚未安装钩子");
    expect(await readdir(project)).not.toContain(".zpi");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
