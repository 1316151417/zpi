import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

// Native focus/panel integration only. Moving between real macOS Spaces still
// requires the manual acceptance sequence in docs/development.md.
test("interactive: quick chat takes input focus without showing a hidden main window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-focus-"));
  const app = await launchDesktop({ dir, url: "" });
  const main = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  const [quick] = await Promise.all([
    app.waitForEvent("window"),
    main.evaluate(() => window.zpi.openQuickChat()),
  ]);
  const state = () =>
    app.evaluate(({ BrowserWindow }) => {
      const windows = BrowserWindow.getAllWindows();
      const quick = windows.find((window) => window.webContents.getURL().includes("view=quick-chat"));
      const main = windows.find((window) => window !== quick);
      return {
        quickVisible: quick?.isVisible(),
        quickFocused: quick?.isFocused(),
        mainVisible: main?.isVisible(),
        mainFocused: main?.isFocused(),
        allSpaces: quick?.isVisibleOnAllWorkspaces(),
        platform: process.platform,
      };
    });
  await expect
    .poll(state)
    .toMatchObject({ quickVisible: true, quickFocused: true, mainVisible: false, mainFocused: false });
  if ((await state()).platform === "darwin") expect((await state()).allSpaces).toBe(true);
  const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
  await input.fill("跨桌面仍保留的草稿");
  await input.press("Escape");
  await expect.poll(state).toMatchObject({ quickVisible: false, mainVisible: false });
  await main.evaluate(() => window.zpi.openQuickChat());
  await expect(input).toHaveValue("跨桌面仍保留的草稿");
  await expect.poll(state).toMatchObject({ quickVisible: true, quickFocused: true, mainVisible: false });
});
