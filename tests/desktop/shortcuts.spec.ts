import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

const primary = process.platform === "darwin" ? "Meta" : "Control";

test("workspace shortcuts use pinned order, ignore repeats and IME, and forward native browser keys", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcuts-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const first = seedHistory(dir, cwd, 1).id;
  const second = seedHistory(dir, cwd, 1).id;
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.evaluate(
      async ({ first, second }) => {
        await window.zpi.setSessionPinned(second, true);
        await window.zpi.setSessionPinned(first, true);
      },
      { first, second },
    );
    await page.reload();
    const pinned = page.locator(".pinned-tasks [data-session-id]");
    await expect(pinned).toHaveCount(2);
    await expect(pinned.first()).toHaveAttribute("data-session-id", second);
    await expect(pinned.locator(".task-row-shortcut")).toHaveCount(0);
    await page.keyboard.down(primary);
    await expect(pinned.locator(".task-row-shortcut")).toHaveCount(2);
    await expect(pinned.first().locator(".task-row-time")).toHaveText(
      process.platform === "darwin" ? "⌘1" : "Ctrl+1",
    );
    await page.keyboard.up(primary);
    await expect(pinned.locator(".task-row-shortcut")).toHaveCount(0);
    await page.keyboard.press(`${primary}+1`);
    await expect(pinned.first()).toHaveClass(/active/);
    await page.keyboard.press(`${primary}+2`);
    await expect(pinned.last()).toHaveClass(/active/);
    await page.keyboard.press(`${primary}+5`);
    await expect(pinned.last()).toHaveClass(/active/);
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator(".shell")).toHaveClass(/left-collapsed/);
    await page.evaluate((mac) => {
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "j",
          code: "KeyJ",
          metaKey: mac,
          ctrlKey: !mac,
          repeat: true,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "j",
          code: "KeyJ",
          metaKey: mac,
          ctrlKey: !mac,
          bubbles: true,
          cancelable: true,
        }),
      );
      window.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
    }, process.platform === "darwin");
    await expect(page.locator(".shell")).toHaveClass(/left-collapsed/);
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator(".shell")).not.toHaveClass(/left-collapsed/);
    await page.keyboard.press(`${primary}+k`);
    await expect(page.getByRole("dialog", { name: "搜索任务", exact: true })).toBeVisible();
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator(".shell")).not.toHaveClass(/left-collapsed/);
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "搜索任务", exact: true })).toHaveCount(0);

    const site = join(dir, "page.html");
    await writeFile(site, "<!doctype html><title>Shortcut fixture</title><input autofocus>");
    const url = pathToFileURL(site).href;
    const browser = await page.evaluate((url) => window.zpi.createBrowser(url), url);
    expect(browser.ok).toBe(true);
    const prevented = await app.evaluate(({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!guest) throw new Error("Missing browser guest");
      let prevented = false;
      guest.emit(
        "before-input-event",
        {
          preventDefault() {
            prevented = true;
          },
        },
        {
          type: "keyDown",
          key: "j",
          code: "KeyJ",
          control: process.platform !== "darwin",
          meta: process.platform === "darwin",
          alt: false,
          shift: false,
          isAutoRepeat: false,
          isComposing: false,
        },
      );
      return prevented;
    }, url);
    expect(prevented).toBe(true);
    await expect(page.locator(".shell")).toHaveClass(/left-collapsed/);
    expect(
      await app.evaluate(({ globalShortcut }) =>
        globalShortcut.isRegistered(process.platform === "darwin" ? "Control+Command+E" : "Control+Alt+E"),
      ),
    ).toBe(false);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("shortcut recording validates conflicts, persists custom keys and disables all app commands", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-shortcut-settings-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    const row = page.locator('[data-shortcut-command="toggle-sidebar"]');
    await row.locator(".shortcut-recorder").click();
    await expect(row.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press(`${primary}+w`);
    await expect(page.getByRole("region", { name: "设置", exact: true })).toBeVisible();
    await expect(page.getByRole("alert")).toContainText("保留");
    await row.locator(".shortcut-recorder").click();
    await expect(row.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "true");
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await expect(row.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "false");
    await row.locator(".shortcut-recorder").click();
    await expect(row.locator(".shortcut-recorder")).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press(`${primary}+k`);
    await expect(page.getByRole("alert")).toContainText("冲突");
    await expect(page.getByRole("button", { name: "保存快捷键", exact: true })).toBeDisabled();
    await row.locator(".shortcut-recorder").click();
    await page.keyboard.press(`${primary}+Shift+j`);
    await page.getByRole("button", { name: "保存快捷键", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("快捷键已保存。");
    await page.getByLabel("关闭设置", { exact: true }).click();
    await page.keyboard.press(`${primary}+j`);
    await expect(page.locator(".shell")).not.toHaveClass(/left-collapsed/);
    await page.keyboard.press(`${primary}+Shift+j`);
    await expect(page.locator(".shell")).toHaveClass(/left-collapsed/);
    await page.keyboard.press(`${primary}+Shift+j`);
    await app.close();
    app = await launchDesktop({ dir, url: "" });
    page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.keyboard.press(`${primary}+Shift+j`);
    await expect(page.locator(".shell")).toHaveClass(/left-collapsed/);
    await page.keyboard.press(`${primary}+Shift+j`);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "快捷键", exact: true }).click();
    await page.getByLabel("启用快捷键", { exact: true }).uncheck();
    await page.getByRole("button", { name: "保存快捷键", exact: true }).click();
    await expect(page.getByRole("status")).toHaveText("快捷键已保存。");
    await page.getByLabel("关闭设置", { exact: true }).click();
    await page.keyboard.press(`${primary}+Shift+j`);
    await page.keyboard.press(`${primary}+l`);
    await page.keyboard.press(`${primary}+k`);
    await expect(page.locator(".shell")).not.toHaveClass(/left-collapsed|pane-open/);
    await expect(page.getByRole("dialog", { name: "搜索任务", exact: true })).toHaveCount(0);
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("native editing still works");
    await editor.press(`${primary}+a`);
    await editor.press("Backspace");
    await expect(editor).toHaveText("");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("pane shortcuts escape xterm without sending terminal input", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-terminal-shortcuts-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "终端", exact: true }).click();
    const input = page.locator(".right-pane .xterm-helper-textarea");
    await expect(input).toBeAttached();
    await app.evaluate(({ ipcMain }) => {
      const state = globalThis as unknown as { shortcutTerminalInputs: number };
      state.shortcutTerminalInputs = 0;
      const original = (
        ipcMain as unknown as {
          _invokeHandlers: Map<string, (event: unknown, method: string, args: unknown[]) => Promise<unknown>>;
        }
      )._invokeHandlers.get("zpi:call");
      if (!original) throw new Error("Missing IPC handler");
      ipcMain.removeHandler("zpi:call");
      ipcMain.handle("zpi:call", (event, method, args) => {
        if (method === "terminalInput") state.shortcutTerminalInputs++;
        return original(event, method, args);
      });
    });
    await input.press(`${primary}+j`);
    await expect(page.locator(".shell")).toHaveClass(/left-collapsed/);
    await input.press(`${primary}+l`);
    await expect(page.locator(".shell")).not.toHaveClass(/pane-open/);
    expect(
      await app.evaluate(
        () => (globalThis as unknown as { shortcutTerminalInputs: number }).shortcutTerminalInputs,
      ),
    ).toBe(0);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
