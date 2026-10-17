import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

// Native focus/panel integration only; this invokes the app API, not the OS hotkey.
// Real hotkeys, macOS Spaces, and latency still require the manual acceptance
// sequence in docs/development.md. Listing this test does not run that acceptance.
test("interactive: quick chat takes input focus without showing a hidden main window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-focus-"));
  const app = await launchDesktop({ dir, url: "" });
  const main = await app.firstWindow();
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
  await main.evaluate(() => window.zpi.openQuickChat());
  const quickPage = () => app.windows().find((page) => page.url().includes("view=quick-chat"));
  await expect.poll(() => Boolean(quickPage())).toBe(true);
  const quick = quickPage();
  if (!quick) throw new Error("Missing quick-chat page");
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
        bounds: quick?.getBounds(),
        platform: process.platform,
      };
    });
  await expect
    .poll(state)
    .toMatchObject({ quickVisible: true, quickFocused: true, mainVisible: false, mainFocused: false });
  if ((await state()).platform === "darwin") expect((await state()).allSpaces).toBe(true);
  await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
  await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeVisible();
  await expect(quick.getByRole("button", { name: /^(新对话|隐藏|关闭)$/ })).toHaveCount(0);
  await expect.poll(state).toMatchObject({ bounds: { width: 360, height: 44 } });
  const compactBounds = (await state()).bounds;
  if (!compactBounds) throw new Error("Missing compact bounds");
  const compactBottom = compactBounds.y + compactBounds.height;
  const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
  await expect(input).toBeFocused();
  await input.fill("第一行");
  await input.press("Shift+Enter");
  await expect.poll(async () => (await state()).bounds?.height ?? 0).toBeGreaterThan(44);
  const multilineBounds = (await state()).bounds;
  if (!multilineBounds) throw new Error("Missing multiline bounds");
  expect(multilineBounds.y + multilineBounds.height).toBe(compactBottom);
  await input.fill("多行草稿\n".repeat(20));
  await expect.poll(state).toMatchObject({ bounds: { width: 360, height: 184 } });
  expect((await state()).bounds?.y).toBe(compactBottom - 184);
  await expect(input).toHaveCSS("overflow-y", "auto");
  expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
  await input.press("Escape");
  await expect.poll(state).toMatchObject({ quickVisible: false, mainVisible: false });
  await main.evaluate(() => window.zpi.openQuickChat());
  await expect(input).toHaveValue("多行草稿\n".repeat(20));
  await expect.poll(state).toMatchObject({
    quickVisible: true,
    quickFocused: true,
    mainVisible: false,
    bounds: { width: 360, height: 184, y: compactBottom - 184 },
  });
  await input.fill("跨桌面仍保留的草稿");
  await expect.poll(state).toMatchObject({ bounds: { width: 360, height: 44, y: compactBounds.y } });
  for (let index = 0; index < 3; index++) {
    await input.press("Escape");
    await expect.poll(state).toMatchObject({ quickVisible: false, mainVisible: false });
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(input).toHaveValue("跨桌面仍保留的草稿");
    await expect(input).toBeFocused();
    await expect.poll(state).toMatchObject({
      quickVisible: true,
      quickFocused: true,
      mainVisible: false,
      mainFocused: false,
      bounds: { width: 360, height: 44, y: compactBounds.y },
    });
  }
});
