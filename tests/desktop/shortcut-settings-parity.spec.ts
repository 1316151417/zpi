import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { shortcutCommands } from "../../packages/desktop/src/shared/shortcuts.ts";
import { done, fakeServer } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

const primary = process.platform === "darwin" ? "Meta" : "Control";
async function settings(page: Page) {
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: "快捷键", exact: true }).click();
}
async function held(page: Page, key: string, code: string) {
  await page.evaluate(
    ({ key, code }) => {
      for (let i = 0; i < 3; i++)
        document.activeElement?.dispatchEvent(
          new KeyboardEvent("keydown", {
            key,
            code,
            metaKey: window.zpi.platform === "darwin",
            ctrlKey: window.zpi.platform !== "darwin",
            repeat: true,
            bubbles: true,
            cancelable: true,
          }),
        );
    },
    { key, code },
  );
}

test("shortcut search, capture, cancel, clear, reset confirmation and failure feedback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-parity-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await settings(page);
    const rows = page.locator("[data-shortcut-command]");
    await expect(rows).toHaveCount(shortcutCommands.length);
    const search = page.getByRole("textbox", { name: "搜索命令或快捷键" });
    await search.fill("选择模型");
    await expect(rows).toHaveCount(1);
    await search.fill(process.platform === "darwin" ? "cmd+l" : "ctrl+l");
    await expect(rows).toHaveAttribute("data-shortcut-command", "select-model");
    await search.fill("不存在的命令");
    await expect(page.getByText("没有匹配的命令或快捷键")).toBeVisible();
    await page.getByRole("button", { name: "清空搜索", exact: true }).click();
    const keySearch = page.getByRole("button", { name: "按组合键搜索", exact: true });
    await keySearch.click();
    await expect(keySearch).toHaveAttribute("aria-pressed", "true");
    await held(page, "k", "KeyK");
    await expect(keySearch).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press(`${primary}+k`);
    await expect(rows).toHaveCount(1);
    await expect(rows).toHaveAttribute("data-shortcut-command", "search");
    await expect(page.locator(".task-search-dialog")).toHaveCount(0);
    await keySearch.click();
    await expect(keySearch).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("Backspace");
    await page.keyboard.press("Escape");
    await expect(keySearch).toHaveAttribute("aria-pressed", "false");
    await expect(rows).toHaveCount(shortcutCommands.length);
    for (const [command, label, shiftKey] of [
      ["quick-chat", "快速对话", false],
      ["quick-chat-new", "新建快速对话", true],
    ] as const) {
      const quickChat = page.locator(`[data-shortcut-command="${command}"]`);
      await quickChat.getByLabel(`编辑${label}快捷键`, { exact: true }).click();
      await expect(quickChat.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "true");
      // Option-letter dead keys and Shift variants use physical letters only for quick-chat commands.
      await page.evaluate(
        (shiftKey) =>
          document.activeElement?.dispatchEvent(
            new KeyboardEvent("keydown", {
              key: "Dead",
              code: "KeyN",
              altKey: true,
              shiftKey,
              bubbles: true,
              cancelable: true,
            }),
          ),
        shiftKey,
      );
      await expect(quickChat.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "false");
      await expect(quickChat.locator(".shortcut-recorder")).toHaveText(
        process.platform === "darwin" ? `⌥${shiftKey ? "⇧" : ""}N` : `Alt${shiftKey ? "Shift" : ""}N`,
      );
    }
    const model = page.locator('[data-shortcut-command="select-model"]');
    const old = await model.locator(".shortcut-recorder").textContent();
    await model.getByLabel("编辑选择模型快捷键", { exact: true }).click();
    await expect(model.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press(`${primary}+u`);
    await expect(model.getByRole("alert")).toContainText("冲突");
    await page.keyboard.press("Alt+b");
    await expect(model.getByRole("alert")).toContainText("Ctrl 或 Command");
    await page.keyboard.press("Escape");
    await expect(model.locator(".shortcut-recorder")).toHaveText(old ?? "");
    await model.getByLabel("清除选择模型快捷键", { exact: true }).click();
    await expect(model.locator(".shortcut-recorder")).toHaveText("未设置");
    await expect(model.getByLabel("清除选择模型快捷键", { exact: true })).toBeDisabled();
    await page.getByLabel("启用快捷键", { exact: true }).uncheck();
    await page.getByRole("button", { name: "全部恢复默认", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await expect(model.locator(".shortcut-recorder")).toHaveText("未设置");
    await page.getByRole("button", { name: "全部恢复默认", exact: true }).click();
    await page.getByRole("button", { name: "恢复默认", exact: true }).click();
    await expect(model.locator(".shortcut-recorder")).toHaveText(old ?? "");
    await expect(page.getByLabel("启用快捷键", { exact: true })).not.toBeChecked();
    // Inject the controller's registration-error response at IPC, without touching OS global keys.
    await app.evaluate(({ ipcMain }) => {
      const handlers = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers;
      const original = handlers.get("zpi:call");
      if (!original) throw new Error("Missing IPC handler");
      let fail = true;
      ipcMain.removeHandler("zpi:call");
      ipcMain.handle("zpi:call", (event, method, args) => {
        if (method === "updateShortcuts" && fail) {
          fail = false;
          return {
            ok: false,
            error: {
              code: "configuration",
              message: "全局快捷键注册失败，可能已被其他应用或系统占用，请更换组合",
            },
          };
        }
        return original(event, method, args);
      });
    });
    await page.getByRole("button", { name: "保存快捷键", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("注册失败");
    expect(
      await page.evaluate(async () => {
        const result = await window.zpi.getSettings();
        return result.ok && result.value.shortcuts.enabled;
      }),
    ).toBe(true);
    await page.getByRole("button", { name: "保存快捷键", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("快捷键已保存。");
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    const reopened = await app.firstWindow();
    await settings(reopened);
    await expect(reopened.getByLabel("启用快捷键", { exact: true })).not.toBeChecked();
    await expect(reopened.locator('[data-shortcut-command="select-model"] .shortcut-recorder')).toHaveText(
      old ?? "",
    );
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("model, search, find and task menu toggle from their own focused layer and ignore repeats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-overlay-shortcuts-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("task menu fixture");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const editor = page.getByLabel("消息", { exact: true });
    for (const [key, code, selector] of [
      ["l", "KeyL", '.model-menu[data-state="open"]'],
      ["k", "KeyK", '.task-search-dialog[data-state="open"]'],
      ["f", "KeyF", ".task-find-bar"],
      ["u", "KeyU", '.task-menu[data-state="open"]'],
    ]) {
      await editor.focus();
      await page.keyboard.press(`${primary}+${key}`);
      await expect(page.locator(selector)).toBeVisible();
      await expect
        .poll(() => page.locator(selector).evaluate((layer) => layer.contains(document.activeElement)))
        .toBe(true);
      await held(page, key, code);
      await expect(page.locator(selector)).toBeVisible();
      await page.keyboard.press(`${primary}+${key}`);
      await expect(page.locator(selector.replace('[data-state="open"]', ""))).toHaveCount(0);
      await expect(editor).toBeFocused();
      await page.keyboard.press(`${primary}+${key}`);
      await expect(page.locator(selector)).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.locator(selector.replace('[data-state="open"]', ""))).toHaveCount(0);
    }
    await editor.focus();
    await page.keyboard.press(`${primary}+u`);
    await expect(page.getByRole("menuitem", { name: "置顶", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "重命名任务", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(page.getByRole("menuitem", { name: "置顶", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator(".pinned-tasks [data-session-id]")).toHaveCount(1);
    await expect(page.locator(".task-menu")).toHaveCount(0);
    await editor.focus();
    await page.keyboard.press(`${primary}+u`);
    await expect(page.getByRole("menuitem", { name: "取消置顶", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: "重命名任务", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("dialog", { name: "重命名任务", exact: true })).toBeVisible();
    await expect(page.locator(".task-menu")).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "名称", exact: true })).toBeFocused();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("environment shortcut closes from the nested branch search and restores its composer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-environment-toggle-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  execFileSync("git", ["init", cwd]);
  execFileSync("git", [
    "-C",
    cwd,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.invalid",
    "commit",
    "--allow-empty",
    "-m",
    "Initial",
  ]);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "", project: cwd });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.focus();
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator('.environment-menu[data-state="open"]').first()).toBeVisible();
    await page.getByRole("menuitemcheckbox", { name: "新工作树" }).click();
    await page.getByRole("menuitem", { name: /起始分支/ }).hover();
    const input = page.locator(".worktree-branch-menu input");
    await expect(input).toBeVisible();
    await input.focus();
    await held(page, "j", "KeyJ");
    await expect(input).toBeVisible();
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator('.environment-menu[data-state="open"]')).toHaveCount(0);
    await expect(editor).toBeFocused();
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator('.environment-menu[data-state="open"]').first()).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(editor).toBeFocused();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
