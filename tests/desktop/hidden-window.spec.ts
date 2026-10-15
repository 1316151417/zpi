import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("desktop automation renders and accepts input without showing or focusing its window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-hidden-window-"));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const presentation = () =>
      app?.evaluate(({ app, BrowserWindow }) => ({
        visible: BrowserWindow.getAllWindows()[0].isVisible(),
        focused: BrowserWindow.getAllWindows()[0].isFocused(),
        throttled: BrowserWindow.getAllWindows()[0].webContents.getBackgroundThrottling(),
        dock: process.platform === "darwin" ? app.dock?.isVisible() : false,
      }));
    expect(await presentation()).toEqual({ visible: false, focused: false, throttled: false, dock: false });
    await page.getByLabel("新建任务", { exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("隐藏测试");
    await editor.press("End");
    await page.keyboard.type("仍可输入");
    await expect(editor).toHaveText("隐藏测试仍可输入");
    expect(await page.evaluate(() => document.visibilityState)).toBe("visible");
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    await page.screenshot({ path: "test-results/hidden-window.png" });
    await app.evaluate(({ app }) => app.emit("second-instance", {}, [], ""));
    await app.evaluate(({ app }) => app.emit("activate", {}, false));
    expect(await presentation()).toEqual({ visible: false, focused: false, throttled: false, dock: false });
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("closing the macOS window keeps the task alive through tool execution and completion", async () => {
  test.skip(process.platform !== "darwin", "macOS closes to hide");
  const dir = await mkdtemp(join(tmpdir(), "zpi-close-to-hide-"));
  let release = () => {};
  let quitRequestClosed = false;
  const server = await fakeServer((_, response, index) => {
    if (index === 2) {
      response.once("close", () => {
        quitRequestClosed = true;
      });
    } else if (index === 0) {
      release = () => {
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "hidden-bash",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "printf hidden-task" }) },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      };
    } else {
      send(response, chunk({ content: "隐藏后任务完成" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    const id = await page.evaluate(async () => {
      const session = await window.zpi.createSession(null);
      if (!session.ok) throw new Error(session.error.message);
      const run = await window.zpi.startRun({ sessionId: session.value.id, text: "隐藏后继续运行" });
      if (!run.ok) throw new Error(run.error.message);
      return session.value.id;
    });
    await expect.poll(() => server.requests.length).toBe(1);
    const contentsId = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      const id = window.webContents.id;
      window.close();
      window.close();
      return id;
    });
    expect(app.process().exitCode).toBeNull();
    expect(
      await app.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        return { visible: window.isVisible(), enabled: window.isEnabled(), id: window.webContents.id };
      }),
    ).toEqual({ visible: false, enabled: true, id: contentsId });
    release();
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const snapshot = await window.zpi.getSessionSnapshot(id);
          return snapshot.ok ? snapshot.value.session.status : "error";
        }, id),
      )
      .toBe("completed");
    expect(server.requests).toHaveLength(2);
    expect(server.requests[1].messages).toEqual(
      expect.arrayContaining([expect.objectContaining({ role: "tool", content: "hidden-task" })]),
    );
    await page.evaluate(async (id) => {
      const run = await window.zpi.startRun({ sessionId: id, text: "退出时停止运行" });
      if (!run.ok) throw new Error(run.error.message);
    }, id);
    await expect.poll(() => server.requests.length).toBe(3);
    const child = app.process();
    await app.close();
    expect(child.exitCode).toBe(0);
    await expect.poll(() => quitRequestClosed).toBe(true);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("startup guards cover child windows, delayed presentation, native APIs and clipboard defaults", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-desktop-guards-"));
  const app = await launchDesktop({ dir, url: "" });
  const page = await app.firstWindow();
  const result = await app.evaluate(
    async ({ app, BrowserWindow, clipboard, dialog, globalShortcut, Menu, shell }) => {
      const state = (
        globalThis as typeof globalThis & {
          __zpiAutomation: {
            createWindow(options: Electron.BrowserWindowConstructorOptions): Electron.BrowserWindow;
            violations: string[];
            snapshot(): { visible: boolean; focused: boolean; focusable: boolean }[];
          };
        }
      ).__zpiAutomation;
      const main = BrowserWindow.getAllWindows()[0];
      // Explicitly asking for show/focusable is still overridden at construction.
      const child = state.createWindow({
        parent: main,
        show: true,
        focusable: true,
        modal: true,
        fullscreen: true,
        kiosk: true,
        width: 300,
        height: 200,
      });
      await child.loadURL(
        "data:text/html,<input autofocus><script>setTimeout(()=>window.open('about:blank'),1)</script>",
      );
      const blocked: string[] = [];
      const actions = {
        show: () => child.show(),
        focus: () => main.focus(),
        restore: () => child.restore(),
        fullscreen: () => child.setFullScreen(true),
        simpleFullscreen: () => child.setSimpleFullScreen(true),
        kiosk: () => child.setKiosk(true),
        showInactive: () => child.showInactive(),
        disable: () => child.setEnabled(false),
        focusable: () => child.setFocusable(true),
        activate: () => app.focus({ steal: true }),
        relaunch: () => app.relaunch(),
        devtools: () => child.webContents.openDevTools(),
        dialog: () => dialog.showOpenDialog({}),
        menu: () => new Menu().popup(),
        shortcut: () => globalShortcut.register("CommandOrControl+Alt+F12", () => {}),
        external: () => shell.openExternal("https://example.invalid"),
        nativeClipboard: () => clipboard.writeHTML("test"),
      };
      await new Promise((resolve) => setTimeout(resolve, 100));
      for (const [name, action] of Object.entries(actions)) {
        try {
          await action();
        } catch {
          blocked.push(name);
        }
      }
      clipboard.writeText("isolated text");
      const snapshot = state.snapshot();
      const recorded = state.violations.splice(0); // These attempts are intentional regression probes.
      child.destroy();
      return {
        blocked,
        recorded,
        snapshot,
        text: clipboard.readText(),
        windows: BrowserWindow.getAllWindows().length,
      };
    },
  );
  expect(result.blocked).toHaveLength(17);
  expect(result.recorded).toHaveLength(17);
  expect(result.snapshot).toEqual(Array(2).fill({ visible: false, focused: false, focusable: false }));
  expect(result.windows).toBe(1);
  expect(result.text).toBe("isolated text");
  await page.getByLabel("新建任务", { exact: true }).first().click();
  expect(
    await page.evaluate(() => {
      const input = document.querySelector('[aria-label="消息"]');
      const event = new ClipboardEvent("paste", {
        bubbles: true,
        cancelable: true,
        clipboardData: new DataTransfer(),
      });
      input?.dispatchEvent(event);
      return event.defaultPrevented;
    }),
  ).toBe(true);
  await page.reload();
  await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
  // The automatic fixture closes the application even without test-local finally.
});
