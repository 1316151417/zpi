import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { nativeWindowOrder } from "../helpers/native-window-order.ts";
import { expect, test } from "../helpers/test.ts";

// Native focus/panel integration only; this invokes the app API, not the OS hotkey.
// Synthetic paste does not use the OS clipboard. Real hotkeys, clipboard, macOS Spaces,
// and latency still require the manual acceptance
// sequence in docs/development.md. Listing this test does not run that acceptance.
test("interactive: floating focus returns to its source without revealing or hiding the main window", async ({
  desktopIsolation: _desktopIsolation,
}, info) => {
  test.skip(process.platform !== "darwin", "macOS application focus");
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-dismiss-"));
  const sourceDir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-source-"));
  const app = await launchDesktop({ dir, url: "" });
  const main = await app.firstWindow();
  const source = await launchDesktop({ dir: sourceDir, url: "" });
  await source.firstWindow();
  const observe = await nativeWindowOrder(dir, [app.process().pid, source.process().pid]);
  const samples: unknown[] = [];
  const state = () =>
    app.evaluate(({ app, BrowserWindow }) => ({
      hidden: app.isHidden(),
      windows: BrowserWindow.getAllWindows().map((window) => ({
        main: !window.webContents.getURL().includes("view=quick-chat"),
        visible: window.isVisible(),
        focused: window.isFocused(),
      })),
    }));
  for (const mainHidden of [false, true]) {
    await app.evaluate(({ BrowserWindow }, hidden) => {
      const main = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes("view=quick-chat"),
      );
      if (!main) throw new Error("Missing main window");
      main.setBounds({ x: 120, y: 120, width: 600, height: 400 });
      if (hidden) main.hide();
      else main.show();
    }, mainHidden);
    await source.evaluate(({ app, BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window.setBounds({ x: 60, y: 60, width: 850, height: 600 });
      window.show();
      app.focus({ steal: true });
      window.focus();
    });
    await expect.poll(async () => (await state()).windows.find((window) => window.main)?.focused).toBe(false);
    const behindSource = async () => {
      const windows = (await observe()).details.filter((window) => window.layer === 0);
      const mainIndex = windows.findIndex((window) => window.pid === app.process().pid);
      const sourceIndex = windows.findIndex((window) => window.pid === source.process().pid);
      return mainIndex < 0 ? mainHidden : sourceIndex >= 0 && mainIndex > sourceIndex;
    };
    await expect.poll(behindSource).toBe(true);
    const before = { ...(await state()), native: await observe() };
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect.poll(() => app.windows().some((page) => page.url().includes("view=quick-chat"))).toBe(true);
    const quick = app.windows().find((page) => page.url().includes("view=quick-chat"));
    if (!quick) throw new Error("Missing quick-chat page");
    await expect(quick.getByRole("textbox", { name: "输入消息", exact: true })).toBeFocused();
    const open = { ...(await state()), native: await observe(), behindSource: await behindSource() };
    await quick.evaluate(() => window.zpiQuickChat.hide());
    const after = { ...(await state()), native: await observe(), behindSource: await behindSource() };
    samples.push({ mainHidden, before, open, after });
    const path = info.outputPath("native-focus-return.json");
    await writeFile(path, JSON.stringify(samples, null, 2));
    await info.attach(`native-focus-return-${mainHidden}`, { path, contentType: "application/json" });
    await expect
      .poll(() => source.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused()))
      .toBe(true);
    expect(open.hidden).toBe(false);
    expect(open.windows.find((window) => window.main)).toMatchObject({
      visible: !mainHidden,
      focused: false,
    });
    expect(open.behindSource).toBe(true);
    expect(after.hidden).toBe(false);
    expect(after.windows.find((window) => window.main)).toMatchObject({
      visible: !mainHidden,
      focused: false,
    });
    expect(after.behindSource).toBe(true);
    // Move the covering window away: the main window must retain its original
    // visible/hidden state rather than being hidden along with the panel.
    await source.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await expect
      .poll(async () => (await state()).windows.find((window) => window.main)?.visible)
      .toBe(!mainHidden);
  }
  await app.evaluate(({ app }) => app.emit("activate", {}, false));
  await expect.poll(async () => (await state()).windows.find((window) => window.main)?.focused).toBe(true);
});

test("interactive: Escape aborts a streaming reply before dismissing the window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-escape-"));
  const server = await fakeServer((_request, response) => {
    send(response, chunk({ content: "本地测试正在生成" }));
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect.poll(() => app?.windows().some((page) => page.url().includes("view=quick-chat"))).toBe(true);
    const quick = app.windows().find((page) => page.url().includes("view=quick-chat"));
    if (!quick) throw new Error("Missing quick-chat page");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    const visible = () =>
      app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("view=quick-chat"))
          ?.isVisible(),
      );
    await input.fill("本地停止测试");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toContainText("本地测试正在生成");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await input.fill("保留下一问草稿");
    await input.press("Escape");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "aborted");
    await expect.poll(visible).toBe(true);
    await expect(input).toHaveValue("保留下一问草稿");
    await input.press("Escape");
    await expect.poll(visible).toBe(false);
    expect(server.requests).toHaveLength(1);
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});

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
  await input.evaluate((element) => {
    const png =
      "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN415H2riONAUIBADY+B3G73tFAAAAAAElFTkSuQmCC";
    const data = new DataTransfer();
    const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
    data.items.add(new File([bytes], "focus.png", { type: "image/png" }));
    element.dispatchEvent(
      new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
    );
  });
  const pendingImages = quick.getByRole("group", { name: "待发送图片", exact: true });
  await expect(pendingImages.getByRole("button", { name: "预览 focus.png", exact: true })).toBeEnabled();
  await expect.poll(state).toMatchObject({ bounds: { width: 360, height: 240, y: compactBottom - 240 } });
  await expect(input).toBeFocused();
  await input.fill("跨桌面仍保留的草稿");
  await expect.poll(state).toMatchObject({ bounds: { width: 360, height: 100, y: compactBottom - 100 } });
  for (let index = 0; index < 3; index++) {
    await input.press("Escape");
    await expect.poll(state).toMatchObject({ quickVisible: false, mainVisible: false });
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(input).toHaveValue("跨桌面仍保留的草稿");
    await expect(pendingImages.getByRole("button", { name: "预览 focus.png", exact: true })).toBeEnabled();
    await expect(input).toBeFocused();
    await expect.poll(state).toMatchObject({
      quickVisible: true,
      quickFocused: true,
      mainVisible: false,
      mainFocused: false,
      bounds: { width: 360, height: 100, y: compactBottom - 100 },
    });
  }
  await pendingImages.getByRole("button", { name: "移除 focus.png", exact: true }).click();
  await expect(pendingImages).toHaveCount(0);
  await expect.poll(state).toMatchObject({ bounds: { width: 360, height: 44, y: compactBounds.y } });
});

// Real visible-window acceptance for the formerly sticky empty-expanded state.
// This is an app-API sequence; actual Option+Space remains manual macOS acceptance.
test("interactive: visible new stays large once and empty hidden resume returns to compact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-resume-"));
  const server = await fakeServer(async (_request, response) => {
    send(response, chunk({ content: "已完成" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect.poll(() => app?.windows().some((page) => page.url().includes("view=quick-chat"))).toBe(true);
    const quick = app.windows().find((page) => page.url().includes("view=quick-chat"));
    if (!quick) throw new Error("Missing quick-chat page");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    const mode = quick.getByTestId("quick-chat");
    const native = () =>
      app?.evaluate(({ BrowserWindow }) => {
        const quick = BrowserWindow.getAllWindows().find((window) =>
          window.webContents.getURL().includes("view=quick-chat"),
        );
        return { visible: quick?.isVisible(), height: quick?.getBounds().height };
      });
    const reopen = async () => {
      await input.press("Escape");
      await expect.poll(native).toMatchObject({ visible: false });
      await main.evaluate(() => window.zpi.openQuickChat());
      await expect.poll(native).toMatchObject({ visible: true });
      await expect(input).toBeFocused();
    };
    await input.fill("建立可见历史");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await quick.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await expect(mode).toHaveAttribute("data-state", "expanded");
    await expect.poll(native).toMatchObject({ visible: true, height: 560 });
    await input.fill("保留未发草稿");
    await reopen();
    await expect(mode).toHaveAttribute("data-state", "expanded");
    await expect(input).toHaveValue("保留未发草稿");
    await input.fill("");
    for (let index = 0; index < 3; index++) {
      await reopen();
      await expect(mode).toHaveAttribute("data-state", "compact");
      await expect.poll(native).toMatchObject({ visible: true, height: 44 });
      await expect(input).toHaveValue("");
    }
    expect(server.requests).toHaveLength(1);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
