import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("quick chat sends drafts immediately with the same composer shortcut", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-immediate-"));
  const server = await fakeServer((_request, response) => send(response, chunk({ content: "waiting" })));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    const mainEditor = main.getByLabel("消息", { exact: true });
    await mainEditor.fill("main draft");
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect.poll(() => app?.windows().some((page) => page.url().includes("view=quick-chat"))).toBe(true);
    const quick = app.windows().find((page) => page.url().includes("view=quick-chat"));
    if (!quick) throw new Error("Missing quick-chat page");
    const primary = await quick.evaluate(() =>
      window.zpiQuickChat.platform === "darwin" ? "Meta" : "Control",
    );
    const editor = quick.getByRole("textbox", { name: "输入消息", exact: true });
    await editor.fill("first draft");
    await editor.press(`${primary}+Enter`);
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect(editor).toHaveValue("");
    await expect.poll(() => server.requests.length).toBe(1);
    await editor.fill("immediate draft");
    await editor.press("Enter");
    await expect(editor).toHaveValue("immediate draft");
    expect(server.requests).toHaveLength(1);
    await editor.press(`${primary}+Enter`);
    await expect(quick.getByTestId("run")).toHaveCount(2);
    await expect(quick.getByTestId("run").first()).toHaveAttribute("data-status", "aborted");
    await expect(quick.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(editor).toHaveValue("");
    await expect.poll(() => server.requests.length).toBe(2);
    const messages = server.requests[1].messages as unknown as { role: string; content: string }[];
    expect(messages.filter((message) => message.role === "user").at(-1)?.content).toBe("immediate draft");
    await expect(mainEditor).toHaveText("main draft");
    await expect(main.getByTestId("run")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("quick chat streams in its own isolated window, survives hide/reload, and leaves main tasks alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-desktop-"));
  const finish = deferred();
  const server = await fakeServer(async (_request, response) => {
    send(response, chunk({ content: "浮窗中的回复" }));
    await finish.promise;
    send(response, chunk({ content: "，已经完成。" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await main.getByLabel("消息", { exact: true }).fill("保留主窗口草稿");
    await expect.poll(() => main.evaluate(() => localStorage.getItem("zpi.selectedSession"))).not.toBeNull();
    const before = await main.evaluate(() => window.zpi.listRecentSessions());
    await main.evaluate(() => window.zpi.openQuickChat());
    // Reuse the prewarmed page when present instead of relying on a new-window event.
    const quickPage = () => app?.windows().find((page) => page.url().includes("view=quick-chat"));
    await expect.poll(() => Boolean(quickPage())).toBe(true);
    const quick = quickPage();
    if (!quick) throw new Error("Missing quick-chat page");
    await expect(quick.getByTestId("quick-chat")).toBeVisible();
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeVisible();
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(quick.getByRole("button", { name: /^(隐藏|关闭)$/ })).toHaveCount(0);
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
    const quickBounds = () =>
      app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("view=quick-chat"))
          ?.getBounds(),
      );
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    const compactBounds = await quickBounds();
    if (!compactBounds) throw new Error("Missing compact bounds");
    const compactBottom = compactBounds.y + compactBounds.height;
    const sendButton = quick.getByRole("button", { name: "发送", exact: true });
    await expect(sendButton).toHaveCSS("width", "28px");
    await expect(sendButton).toHaveCSS("height", "28px");
    await expect(sendButton).toHaveCSS("border-radius", "50%");
    expect(await quick.evaluate(() => typeof window.zpi)).toBe("undefined");
    expect(await quick.evaluate(() => typeof window.zpiQuickChat.send)).toBe("function");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    await input.fill("第一行");
    await input.press("Shift+Enter");
    await expect(input).toHaveValue("第一行\n");
    await expect.poll(async () => (await quickBounds())?.height ?? 0).toBeGreaterThan(44);
    const multilineBounds = await quickBounds();
    if (!multilineBounds) throw new Error("Missing multiline bounds");
    expect(multilineBounds.width).toBe(360);
    expect(multilineBounds.height).toBeLessThanOrEqual(184);
    expect(multilineBounds.y + multilineBounds.height).toBe(compactBottom);
    await input.fill("长草稿\n".repeat(20));
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 184 });
    await expect
      .poll(() => input.evaluate((element) => element.scrollHeight > element.clientHeight))
      .toBe(true);
    await expect(input).toHaveCSS("overflow-y", "auto");
    expect((await quickBounds())?.y).toBe(compactBottom - 184);
    expect(server.requests).toHaveLength(0);
    await input.fill("只在浮窗回答");
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    expect((await quickBounds())?.y).toBe(compactBounds.y);
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    expect(await quick.evaluate(() => "setSelection" in window.zpiQuickChat)).toBe(false);
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect.poll(quickBounds).toMatchObject({ width: 660, height: 560 });
    await expect(quick.getByTestId("run")).toContainText("浮窗中的回复");
    await expect(quick.getByTestId("run")).toHaveCSS("padding-top", "8px");
    await expect(quick.getByTestId("run")).toHaveCSS("padding-bottom", "16px");
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "expanded");
    await expect(quick.locator(".quick-chat-header button")).toHaveCount(1);
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toBeVisible();
    await expect(quick.getByRole("button", { name: /^(隐藏|关闭)$/ })).toHaveCount(0);
    expect(
      await quick.locator(".quick-chat-header").evaluate((header) => {
        const button = header.querySelector('button[aria-label="新对话"]');
        if (!button) return false;
        const headerBounds = header.getBoundingClientRect();
        const buttonBounds = button.getBoundingClientRect();
        return (
          buttonBounds.x >= headerBounds.x && buttonBounds.right < headerBounds.x + headerBounds.width / 2
        );
      }),
    ).toBe(true);
    // Visibility shortcuts may hide an active run; Escape now stops it first.
    await quick.evaluate(() => window.zpiQuickChat.hide());
    await quick.reload();
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect.poll(quickBounds).toMatchObject({ width: 660, height: 560 });
    finish.resolve();
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(quick.getByTestId("run")).toContainText("已经完成");
    await input.fill("展开后的长草稿\n".repeat(20));
    await expect(input).toHaveCSS("height", "160px");
    await expect(input).toHaveCSS("overflow-y", "auto");
    expect(await input.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true);
    expect(await quickBounds()).toMatchObject({ width: 660, height: 560 });
    await input.fill("第二轮");
    await expect(input).toHaveCSS("height", "24px");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveCount(2);
    await expect(quick.getByTestId("run").nth(1)).toHaveAttribute("data-status", "completed");
    await expect(quick.getByTestId("run").nth(1)).toHaveCSS("padding-top", "12px");
    await expect(quick.getByTestId("run").nth(1)).toHaveCSS("padding-bottom", "16px");
    await expect(main.getByLabel("消息", { exact: true })).toHaveText("保留主窗口草稿");
    expect(await main.evaluate(() => window.zpi.listRecentSessions())).toEqual(before);
    expect(await quick.evaluate(() => Object.keys(localStorage))).toEqual([]);
    const rejected = await app.evaluate(async ({ BrowserWindow, ipcMain }) => {
      const quickWindow = BrowserWindow.getAllWindows().find((window) =>
        window.webContents.getURL().includes("view=quick-chat"),
      );
      const handler = (
        ipcMain as unknown as { _invokeHandlers: Map<string, (...args: unknown[]) => unknown> }
      )._invokeHandlers.get("zpi:call");
      if (!quickWindow || !handler) throw new Error("Missing quick-chat integration");
      return handler(
        { sender: quickWindow.webContents, senderFrame: quickWindow.webContents.mainFrame },
        "createSession",
        [null],
      );
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    // Background desktop tests never present the native window, so explicit new starts compact.
    await input.fill("新对话应清空草稿");
    await quick.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    await expect(input).toHaveValue("");
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeDisabled();
    await expect(quick.getByRole("button", { name: "新对话", exact: true })).toHaveCount(0);
    await input.press("Escape");
    await quick.reload();
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    await expect(quick.getByTestId("run")).toHaveCount(0);
    expect(await main.evaluate(() => window.zpi.listRecentSessions())).toEqual(before);
    expect(app.windows()).toHaveLength(2);
  } finally {
    finish.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

// Deliver bytes in a page event; never read or mutate the user's system clipboard.
const pastedPng =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWN415H2riONAUIBADY+B3G73tFAAAAAAElFTkSuQmCC";
async function pasteImages(input: Locator, names: string[], text = "") {
  await input.evaluate(
    (element, { png, names, text }) => {
      const data = new DataTransfer();
      const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
      for (const name of names) data.items.add(new File([bytes], name, { type: "image/png" }));
      if (text) data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    },
    { png: pastedPng, names, text },
  );
}

test("quick chat error details open for three seconds and remain inside the compact native window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-notice-"));
  const server = await fakeServer((_request, response) => {
    send(response, chunk({ content: "无需发送" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect.poll(() => app?.windows().some((page) => page.url().includes("view=quick-chat"))).toBe(true);
    const quick = app.windows().find((page) => page.url().includes("view=quick-chat"));
    if (!quick) throw new Error("Missing quick-chat page");
    const bounds = () =>
      app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("view=quick-chat"))
          ?.getBounds(),
      );
    await expect.poll(bounds).toMatchObject({ width: 360, height: 44 });
    const before = await bounds();
    if (!before) throw new Error("Missing compact bounds");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    await input.fill("保留草稿");
    await pasteImages(
      input,
      Array.from({ length: 9 }, (_, index) => `notice-${index}.png`),
    );
    const tooltip = quick.getByRole("tooltip");
    await expect(tooltip).toContainText("每条消息最多可添加 8 张图片");
    await expect
      .poll(async () => {
        const bubble = await tooltip.boundingBox();
        return Boolean(bubble && bubble.y >= 0 && bubble.x >= 0 && bubble.x + bubble.width <= 360);
      })
      .toBe(true);
    const opened = await bounds();
    expect(opened && opened.y + opened.height).toBe(before.y + before.height);
    await expect(tooltip).toHaveCount(0, { timeout: 5000 });
    await expect.poll(bounds).toMatchObject({ height: 100 });
    const indicator = quick.getByRole("button", { name: "查看错误原因", exact: true });
    // Native top-edge expansion changes page coordinates; deliver hover at the anchored control.
    await indicator.dispatchEvent("pointerover", { pointerType: "mouse" });
    await expect(tooltip).toBeVisible();
    await indicator.focus();
    await indicator.press("Escape");
    await expect(tooltip).toHaveCount(0);
    await expect.poll(bounds).toMatchObject({ height: 100 });
    await expect(input).toHaveValue("保留草稿");
    expect(server.requests).toHaveLength(0);
    await quick.getByRole("button", { name: "关闭提示", exact: true }).click();
    await expect(quick.locator(".quick-chat-error")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("expanded window shows file link errors as a fully visible tooltip above the indicator", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-expanded-error-"));
  const server = await fakeServer((_request, response) => {
    send(response, chunk({ content: "试试 [link-test.md](./link-test.md) 文件。" }));
    done(response);
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
    await input.fill("回复一个本地文件链接");
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await quick.getByRole("button", { name: "link-test.md", exact: true }).click();
    const tooltip = quick.getByRole("tooltip");
    await expect(tooltip).toContainText("快速对话不支持预览本地文件");
    const trigger = quick.getByRole("button", { name: "查看错误原因", exact: true });
    const send = quick.getByRole("button", { name: "发送", exact: true });
    await expect
      .poll(async () => {
        const bubble = await tooltip.boundingBox();
        const icon = await trigger.boundingBox();
        const sendBox = await send.boundingBox();
        return (
          bubble &&
          icon &&
          sendBox && {
            insideX: bubble.x >= 12 && bubble.x + bubble.width <= 648,
            above: bubble.y + bubble.height <= icon.y,
            besideSend: icon.x + icon.width <= sendBox.x,
          }
        );
      })
      .toMatchObject({ insideX: true, above: true, besideSend: true });
    await expect(tooltip).toHaveCount(0, { timeout: 5000 });
    await trigger.hover();
    await expect(tooltip).toBeVisible();
    const bubble = await tooltip.boundingBox();
    expect(bubble && bubble.x >= 12 && bubble.x + bubble.width <= 648).toBe(true);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

async function configureImageModel(page: Page, supportsImages: boolean) {
  await page.evaluate(async (supportsImages) => {
    const settings = await window.zpi.getSettings();
    if (!settings.ok) throw new Error(settings.error.message);
    const provider = settings.value.providers[0];
    const saved = await window.zpi.saveProvider({
      id: provider.id,
      name: provider.name,
      baseUrl: provider.baseUrl,
      apiKey: "",
      models: [{ id: "fake", input: supportsImages ? ["text", "image"] : ["text"], reasoning: true }],
    });
    if (!saved.ok) throw new Error(saved.error.message);
  }, supportsImages);
}

test("quick chat pastes, previews and sends temporary images without creating main task history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-images-"));
  const server = await fakeServer((_request, response) => {
    send(response, chunk({ content: "已收到临时图片。" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await configureImageModel(main, true);
    const mainInput = main.getByLabel("消息", { exact: true });
    await mainInput.fill("主任务文字和图片列表不变");
    await expect.poll(() => main.evaluate(() => localStorage.getItem("zpi.selectedSession"))).not.toBeNull();
    const before = await main.evaluate(() => window.zpi.listRecentSessions());
    await main.evaluate(() => window.zpi.openQuickChat());
    const quickPage = () => app?.windows().find((page) => page.url().includes("view=quick-chat"));
    await expect.poll(() => Boolean(quickPage())).toBe(true);
    const quick = quickPage();
    if (!quick) throw new Error("Missing quick-chat page");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    const sendButton = quick.getByRole("button", { name: "发送", exact: true });
    const pendingImages = quick.getByRole("group", { name: "待发送图片", exact: true });
    const quickBounds = () =>
      app?.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().includes("view=quick-chat"))
          ?.getBounds(),
      );
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 44 });
    const compactBounds = await quickBounds();
    if (!compactBounds) throw new Error("Missing compact bounds");
    const compactBottom = compactBounds.y + compactBounds.height;
    await input.fill("图片附带的长草稿\n".repeat(20));
    await pasteImages(input, ["keep.png", "remove.png"]);
    await expect(pendingImages.locator(".image-chip")).toHaveCount(2);
    await expect(pendingImages.getByRole("button", { name: "预览 keep.png", exact: true })).toBeEnabled();
    await expect(pendingImages.getByRole("button", { name: "预览 remove.png", exact: true })).toBeEnabled();
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 240, y: compactBottom - 240 });
    // Native layout acceptance: the removed filename must not retain its old 24px row.
    expect(
      await quick.locator(".quick-chat-composer").evaluate((composer) => {
        const images = composer.querySelector(".quick-chat-attachments")?.getBoundingClientRect();
        const row = composer.querySelector(".quick-chat-composer-input-row")?.getBoundingClientRect();
        return images && row ? { height: images.height, gap: row.top - images.bottom } : null;
      }),
    ).toEqual({ height: 48, gap: 8 });
    await expect(input).toHaveCSS("overflow-y", "auto");
    await pendingImages.getByRole("button", { name: "预览 keep.png", exact: true }).click();
    const preview = quick.getByRole("dialog", { name: "图片预览", exact: true });
    await expect(preview).toBeVisible();
    await expect(preview.getByRole("img", { name: "keep.png", exact: true })).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await pendingImages.getByRole("button", { name: "移除 remove.png", exact: true }).click();
    await expect(pendingImages.locator(".image-chip")).toHaveCount(1);
    await expect(pendingImages).not.toContainText("remove.png");
    expect(server.requests).toHaveLength(0);
    await input.press("Escape");
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(input).toHaveValue("图片附带的长草稿\n".repeat(20));
    await expect(pendingImages.getByRole("button", { name: "预览 keep.png", exact: true })).toBeEnabled();
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 240, y: compactBottom - 240 });
    await input.fill("说明截图");
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 100, y: compactBottom - 100 });
    await sendButton.click();
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(pendingImages).toHaveCount(0);
    await expect(input).toHaveValue("");
    expect(server.requests).toHaveLength(1);
    const firstMessages = server.requests[0].messages as unknown as { role: string; content: unknown }[];
    expect(firstMessages.findLast((message) => message.role === "user")?.content).toEqual([
      { type: "text", text: "说明截图" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ]);
    const firstSnapshot = await quick.evaluate(() => window.zpiQuickChat.getSnapshot());
    if (!firstSnapshot.ok) throw new Error(firstSnapshot.error.message);
    const sessionId = firstSnapshot.value.session.sessionId;
    const firstImage = firstSnapshot.value.session.runs[0].attachments?.[0];
    if (!firstImage) throw new Error("Missing quick-chat image metadata");
    expect(firstSnapshot.value.session.runs[0].attachments).toHaveLength(1);
    expect(firstImage).toMatchObject({ name: "keep.png", width: 2, height: 2, mimeType: "image/png" });
    await quick.getByTestId("run").getByRole("button", { name: "预览 keep.png", exact: true }).click();
    const header = quick.locator(".quick-chat-header");
    await expect(header).toHaveCount(1);
    await expect(preview.getByRole("img", { name: "keep.png", exact: true })).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    // The preview covers the native drag header, which would otherwise move the window instead of clicking.
    await expect(header).toHaveCSS("app-region", "no-drag");
    await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
    await expect(preview).toHaveCount(0);
    await expect(header).toHaveCSS("app-region", "drag");
    await pasteImages(input, ["solo.png"]);
    await expect(sendButton).toBeEnabled();
    await expect(input).toHaveValue("");
    await input.press("Enter");
    await expect(quick.getByTestId("run").nth(1)).toHaveAttribute("data-status", "completed");
    expect(server.requests).toHaveLength(2);
    const imageOnlyMessages = server.requests[1].messages as unknown as { role: string; content: unknown }[];
    expect(imageOnlyMessages.findLast((message) => message.role === "user")?.content).toEqual([
      { type: "text", text: "" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ]);
    await configureImageModel(main, false);
    await input.fill("历史含图片时不能改用纯文字模型");
    await input.press("Enter");
    await expect(quick.getByRole("alert")).toContainText("当前模型不支持图片");
    await expect(input).toHaveValue("历史含图片时不能改用纯文字模型");
    expect(server.requests).toHaveLength(2);
    await pasteImages(input, ["clear-on-reset.png"]);
    await expect(
      pendingImages.getByRole("button", { name: "预览 clear-on-reset.png", exact: true }),
    ).toBeEnabled();
    await quick.getByRole("button", { name: "新对话", exact: true }).click();
    await expect(quick.getByTestId("run")).toHaveCount(0);
    await expect(pendingImages).toHaveCount(0);
    await expect(input).toHaveValue("");
    await expect(quick.getByTestId("quick-chat")).toHaveAttribute("data-state", "compact");
    expect(
      await quick.evaluate(({ sessionId, id }) => window.zpiQuickChat.readAttachment(sessionId, id), {
        sessionId,
        id: firstImage.id,
      }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
    await expect(mainInput).toHaveText("主任务文字和图片列表不变");
    await expect(main.locator(".composer .image-chip")).toHaveCount(0);
    expect(await main.evaluate(() => window.zpi.listRecentSessions())).toEqual(before);
    expect(await quick.evaluate(() => Object.keys(localStorage))).toEqual([]);
    expect(server.titleRequests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("quick chat restores text and image drafts after a provider failure and can retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-quick-chat-image-retry-"));
  const server = await fakeServer((_request, response, index) => {
    if (!index) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "image request rejected by fake provider" } }));
      return;
    }
    send(response, chunk({ content: "图片重试完成。" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const main = await app.firstWindow();
    await configureImageModel(main, true);
    await expect.poll(() => main.evaluate(() => localStorage.getItem("zpi.selectedSession"))).not.toBeNull();
    const before = await main.evaluate(() => window.zpi.listRecentSessions());
    await main.evaluate(() => window.zpi.openQuickChat());
    const quickPage = () => app?.windows().find((page) => page.url().includes("view=quick-chat"));
    await expect.poll(() => Boolean(quickPage())).toBe(true);
    const quick = quickPage();
    if (!quick) throw new Error("Missing quick-chat page");
    const input = quick.getByRole("textbox", { name: "输入消息", exact: true });
    const pendingImages = quick.getByRole("group", { name: "待发送图片", exact: true });
    await pasteImages(input, ["retry.png"], "失败后保留的文字");
    await expect(input).toHaveValue("失败后保留的文字");
    await expect(quick.getByRole("button", { name: "发送", exact: true })).toBeEnabled();
    await input.press("Enter");
    await expect(quick.getByTestId("run")).toHaveAttribute("data-status", "error");
    await expect(input).toHaveValue("失败后保留的文字");
    await expect(pendingImages.getByRole("button", { name: "预览 retry.png", exact: true })).toBeEnabled();
    await input.press("Escape");
    await main.evaluate(() => window.zpi.openQuickChat());
    await expect(input).toHaveValue("失败后保留的文字");
    await expect(pendingImages.locator(".image-chip")).toHaveCount(1);
    await input.press("Enter");
    await expect(quick.getByTestId("run").nth(1)).toHaveAttribute("data-status", "completed");
    await expect(pendingImages).toHaveCount(0);
    await expect(input).toHaveValue("");
    expect(server.requests).toHaveLength(2);
    const retriedMessages = server.requests[1].messages as unknown as { role: string; content: unknown }[];
    expect(retriedMessages.findLast((message) => message.role === "user")?.content).toEqual([
      { type: "text", text: "失败后保留的文字" },
      { type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } },
    ]);
    expect(await main.evaluate(() => window.zpi.listRecentSessions())).toEqual(before);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
