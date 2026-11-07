import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("plugin settings manage init while existing sessions retain frozen commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-plugins-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ready" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("freeze plugin configuration");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const oldId = await page.evaluate(async () => {
      const result = await window.zpi.listRecentSessions();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.find((session) => !session.draft)?.id;
    });
    expect(oldId).toBeTruthy();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await expect(page.locator(".capability-settings .settings-row strong")).toHaveText([
      "交互方式",
      "多工具调用",
      "文件链接格式",
      "文件内容复用",
      "主动推进",
      "项目初始化",
      "向用户提问",
      "联网搜索",
      "子智能体协作",
      "后台命令",
      "记忆策略",
      "会话标题",
      "任务通知",
      "记忆模式",
      "协作提示预设",
    ]);
    await page.getByRole("checkbox", { name: "项目初始化", exact: true }).uncheck();
    await expect(page.getByRole("checkbox", { name: "项目初始化", exact: true })).toBeEnabled();
    const commands = await page.evaluate(async (id) => {
      const old = await window.zpi.listCommands(id);
      const current = await window.zpi.listCommands();
      if (!old.ok || !current.ok) throw new Error("Command catalog failed");
      return { old: old.value.map((c) => c.name), current: current.value.map((c) => c.name) };
    }, oldId);
    expect(commands.old).toContain("init");
    expect(commands.current).not.toContain("init");
    await page.getByRole("combobox", { name: "记忆模式", exact: true }).click();
    await page.getByRole("option", { name: "长期记忆", exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await window.zpi.getMemorySettings();
          return result.ok && result.value.long;
        }),
      )
      .toBe(true);
    await expect(page.getByRole("checkbox", { name: "向用户提问", exact: true })).toBeChecked();
    await expect(page.getByRole("checkbox", { name: "后台命令", exact: true })).toBeChecked();
    await expect(page.getByRole("button", { name: "扩展能力", exact: true })).toHaveCount(0);
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "项目初始化", exact: true })).not.toBeChecked();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("plugin settings and feature tabs share memory, notification and collaboration state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-plugin-settings-sync-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const tab = (name: string) => page.getByRole("button", { name, exact: true }).click();
    const plugin = (name: string) => page.getByRole("checkbox", { name, exact: true });
    const mode = page.getByRole("combobox", { name: "记忆模式", exact: true });
    const short = page.getByRole("switch", { name: "短记忆", exact: true });
    await tab("设置");
    await tab("插件");
    await mode.click();
    await page.getByRole("option", { name: "短记忆", exact: true }).click();
    await expect(mode).toBeEnabled();
    await tab("记忆");
    await expect(short).toBeChecked();
    await short.uncheck();
    await expect(short).toBeEnabled();
    await tab("插件");
    await expect(mode).toHaveText("关闭");
    await tab("记忆");
    await short.check();
    await expect(short).toBeEnabled();
    await tab("插件");
    await expect(mode).toHaveText("短记忆");
    await plugin("记忆策略").uncheck();
    await expect(mode).toHaveText("关闭");
    await expect(mode).toBeDisabled();
    await tab("记忆");
    await expect(short).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "长期记忆", exact: true })).not.toBeChecked();
    await tab("插件");
    await plugin("记忆策略").check();
    await expect(mode).toHaveText("短记忆");

    await plugin("任务通知").uncheck();
    await expect(plugin("任务通知")).toBeEnabled();
    await tab("常规");
    const notifications = page.getByRole("switch", { name: "任务通知", exact: true });
    await expect(notifications).not.toBeChecked();
    await expect(page.getByRole("switch", { name: "通知声音", exact: true })).toBeDisabled();
    await notifications.check();
    await tab("插件");
    await expect(plugin("任务通知")).toBeChecked();

    await plugin("子智能体协作").uncheck();
    await expect(plugin("子智能体协作")).toBeEnabled();
    await tab("子智能体");
    const collaboration = page.getByRole("switch", { name: "启用子智能体", exact: true });
    await expect(collaboration).not.toBeChecked();
    await collaboration.check();
    const codex = page.getByRole("switch", { name: "Codex 子智能体提示", exact: true });
    await codex.check();
    await tab("插件");
    const preset = page.getByRole("combobox", { name: "协作提示预设", exact: true });
    await expect(plugin("子智能体协作")).toBeChecked();
    await expect(preset).toHaveText("Codex");
    await preset.click();
    await page.getByRole("option", { name: "默认", exact: true }).click();
    await expect(preset).toBeEnabled();
    await tab("子智能体");
    await expect(codex).not.toBeChecked();

    await page.reload();
    await tab("设置");
    await tab("插件");
    await expect(mode).toHaveText("短记忆");
    await expect(plugin("任务通知")).toBeChecked();
    await expect(plugin("子智能体协作")).toBeChecked();
    await expect(preset).toHaveText("默认");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

for (const colorScheme of ["light", "dark"] as const) {
  test(`plugin installation toolbar and local folder import work in ${colorScheme} mode`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-plugin-toolbar-"));
    const source = join(dir, "sample-plugin");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await mkdir(join(source, "commands"));
    await writeFile(
      join(source, ".claude-plugin", "plugin.json"),
      JSON.stringify({ name: "sample-plugin", version: "1.0.0", description: "本地插件示例" }),
    );
    await writeFile(join(source, "commands", "hello.md"), "Say hello to $ARGUMENTS.");
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, url: "" });
      const page = await app.firstWindow();
      await page.emulateMedia({ colorScheme });
      await page.getByRole("button", { name: "设置", exact: true }).click();
      await page.getByRole("button", { name: "插件", exact: true }).click();
      const installed = page.getByRole("region", { name: "已安装插件", exact: true });
      await expect(installed.getByRole("heading")).toHaveText("已安装 0");
      await expect(installed.getByText("尚未安装插件", { exact: true })).toBeVisible();
      await expect(page.getByText("插件市场", { exact: false })).toHaveCount(0);
      for (const width of [1280, 800, 640]) {
        await page.setViewportSize({ width, height: 900 });
        expect(await installed.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(false);
        await expect(installed.getByRole("button", { name: "添加插件", exact: true })).toBeVisible();
        const alignment = await installed.evaluate((element) => {
          const title = element.querySelector("h2")?.getBoundingClientRect();
          const add = element.querySelector(".plugin-add")?.getBoundingClientRect();
          if (!title || !add) throw new Error("Missing plugin toolbar");
          return Math.abs((title.top + title.bottom - add.top - add.bottom) / 2);
        });
        expect(alignment).toBeLessThan(1);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({
        path: test.info().outputPath(`plugins-${colorScheme}.png`),
        animations: "disabled",
      });
      await app.evaluate(({ dialog }) => {
        dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
      });
      await installed.getByRole("button", { name: "添加本地插件", exact: true }).click();
      await expect(installed.getByRole("button", { name: "添加插件", exact: true })).toBeEnabled();
      await expect(installed.getByRole("heading")).toHaveText("已安装 0");
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
      }, source);
      await installed.getByRole("button", { name: "添加插件", exact: true }).click();
      await expect(page.getByRole("menuitem", { name: "从本地文件夹添加", exact: true })).toBeVisible();
      expect(
        await page.locator(".plugin-add-menu").evaluate((menu) => Number(getComputedStyle(menu).zIndex)),
      ).toBeGreaterThan(
        await page.locator(".settings-screen").evaluate((screen) => Number(getComputedStyle(screen).zIndex)),
      );
      await page.screenshot({
        path: test.info().outputPath(`plugins-add-${colorScheme}.png`),
        animations: "disabled",
      });
      await page.getByRole("menuitem", { name: "从本地文件夹添加", exact: true }).click();
      await expect(installed.getByRole("heading")).toHaveText("已安装 1");
      await expect(installed.getByRole("checkbox", { name: "sample-plugin", exact: true })).toBeChecked();
      await expect(installed.locator(".plugin-empty")).toHaveCount(0);
      await installed.getByRole("button", { name: "刷新插件", exact: true }).click();
      await expect(installed.getByRole("checkbox", { name: "sample-plugin", exact: true })).toBeChecked();
      const commands = await page.evaluate(() => window.zpi.listCommands());
      expect(commands.ok && commands.value.some((command) => command.name === "sample-plugin:hello")).toBe(
        true,
      );
    } finally {
      await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
    }
  });
}
