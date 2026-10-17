import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

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
    await input.press("Escape");
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
    await expect(main.getByLabel("消息", { exact: true })).toHaveValue("保留主窗口草稿");
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
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 264, y: compactBottom - 264 });
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
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 264, y: compactBottom - 264 });
    await input.fill("说明截图");
    await expect.poll(quickBounds).toMatchObject({ width: 360, height: 124, y: compactBottom - 124 });
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
    await expect(preview.getByRole("img", { name: "keep.png", exact: true })).toHaveAttribute(
      "src",
      /^data:image\/png;base64,/,
    );
    await preview.getByRole("button", { name: "关闭图片预览", exact: true }).click();
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
    await expect(mainInput).toHaveValue("主任务文字和图片列表不变");
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
