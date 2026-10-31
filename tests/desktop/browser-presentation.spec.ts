import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import sharp from "sharp";
import { done, fakeServer } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("tab overview preserves browser pixels and page state while its menu remains interactive", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-browser-overview-"));
  const file = join(dir, "preview.html");
  await writeFile(
    file,
    '<html><title>Overview fixture</title><body style="margin:0;background:rgb(18,52,86)"><input id="draft"><script>window.fixtureToken = Math.random()</script></body></html>',
  );
  const url = pathToFileURL(file).href;
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "浏览器", exact: true }).click();
    await page.getByLabel("浏览器地址").fill(url);
    await page.getByLabel("浏览器地址").press("Enter");
    await expect(page.getByRole("tab", { name: "Overview fixture", exact: true })).toBeVisible();
    const original = await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!guest) throw Error("Missing browser fixture");
      const token = await guest.executeJavaScript(
        "document.querySelector('#draft').value = 'keep my draft'; history.pushState({}, '', '#kept'); window.fixtureToken",
      );
      return { id: guest.id, token };
    }, url);
    for (const [width, fullView] of [
      [1200, false],
      [900, false],
      [1200, true],
    ] as const) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 800),
        width,
      );
      if (fullView) {
        await page.emulateMedia({ colorScheme: "dark" });
        await page.getByLabel("进入完整视图", { exact: true }).click();
      }
      await page.getByRole("button", { name: "搜索标签页", exact: true }).click();
      const menu = page.locator(".pane-tab-overview");
      await expect(menu).toBeVisible();
      await expect(menu).not.toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await expect(menu).toHaveCSS("opacity", "1");
      await page.getByPlaceholder("搜索标签页...").fill("Overview");
      await expect(menu.getByText("Overview fixture", { exact: true })).toBeVisible();
      // 检查宿主窗口的真实合成像素，避免只验证 guest 仍存活却漏掉页面已被隐藏的白屏。
      await expect
        .poll(async () => {
          const rect = await page.getByTestId("browser-surface").boundingBox();
          if (!rect) return [];
          const screenshot = await page.screenshot({ scale: "css" });
          const pixel = await sharp(screenshot)
            .extract({
              left: Math.floor(rect.x + rect.width - 24),
              top: Math.floor(rect.y + rect.height * 0.6),
              width: 1,
              height: 1,
            })
            .removeAlpha()
            .raw()
            .toBuffer();
          return [...pixel];
        })
        .toEqual([18, 52, 86]);
      await page.screenshot({ path: `test-results/browser-overview-${fullView ? "full" : width}.png` });
      await menu.getByText("Overview fixture", { exact: true }).click();
      await expect(menu).toHaveCount(0);
      expect(
        await app.evaluate(async ({ webContents }, id) => {
          const guest = webContents.fromId(id);
          if (!guest) return null;
          return {
            url: guest.getURL(),
            state: await guest.executeJavaScript(
              "[document.querySelector('#draft').value, window.fixtureToken]",
            ),
          };
        }, original.id),
      ).toEqual({ url: `${url}#kept`, state: ["keep my draft", original.token] });
      await page.getByRole("button", { name: "搜索标签页", exact: true }).click();
      await page.keyboard.press("Escape");
      await expect(menu).toHaveCount(0);
    }
    await page.getByLabel("退出完整视图", { exact: true }).click();
    await page.getByLabel("新增侧栏标签", { exact: true }).click();
    await expect(page.locator(".browser-webview:visible")).toHaveCount(0);
    await page.getByRole("button", { name: "搜索标签页", exact: true }).click();
    await page.locator(".pane-tab-overview").getByText("Overview fixture", { exact: true }).click();
    await expect(page.locator(".pane-tab-overview")).toHaveCount(0);
    expect(
      await page
        .locator(".browser-webview:visible")
        .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId()),
    ).toBe(original.id);
    await page.getByRole("button", { name: "搜索标签页", exact: true }).click();
    await page.locator(".pane-tab-overview").getByLabel("关闭标签 Overview fixture", { exact: true }).click();
    await expect
      .poll(() => app?.evaluate(({ webContents }, id) => webContents.fromId(id) === undefined, original.id))
      .toBe(true);
    await page.locator(".pane-tab-overview").getByText("Overview fixture", { exact: true }).click();
    await expect(page.getByRole("tab", { name: "Overview fixture", exact: true })).toBeVisible();
    expect(
      await page
        .locator(".browser-webview:visible")
        .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId()),
    ).not.toBe(original.id);
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([() => app?.close(), () => rm(dir, { recursive: true, force: true })]);
  }
});

test("browser has a seamless blank canvas and a centered editable address pill", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-browser-presentation-"));
  const file = join(dir, "preview.html");
  await writeFile(
    file,
    '<html><title>Preview fixture</title><body style="background: rgb(18, 52, 86)">Local fixture</body></html>',
  );
  const server = await fakeServer((_, response) => done(response));
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "浏览器", exact: true }).click();
    const pane = page.locator(".browser-pane");
    const toolbar = pane.locator(".browser-toolbar");
    const address = page.getByLabel("浏览器地址", { exact: true });
    await expect(toolbar.getByRole("button")).toHaveCount(4);
    await expect(pane.locator(".pane-empty")).toHaveCount(0);
    await expect(pane.getByTestId("browser-surface")).toBeEmpty();
    await expect(toolbar).toHaveCSS("height", "48px");
    await expect(toolbar).toHaveCSS("border-bottom-width", "0px");
    const background = await pane.evaluate((element) => getComputedStyle(element).backgroundColor);
    await expect(toolbar).toHaveCSS("background-color", background);
    await expect(pane.getByTestId("browser-surface")).toHaveCSS("background-color", background);
    await expect(address).toHaveAttribute("placeholder", "输入网址后回车");
    await expect(address).toHaveCSS("height", "32px");
    await expect(address).toHaveCSS("border-radius", "9999px");
    await address.evaluate((element) => element.blur());
    await expect(address).toHaveCSS("text-align", "center");
    await address.focus();
    await expect(address).toHaveCSS("text-align", "left");
    await address.fill(file);
    await address.press("Enter");
    await expect(address).toHaveValue(pathToFileURL(file).href);
    await expect(page.getByLabel("在外部浏览器打开", { exact: true })).toBeEnabled();
    // Inspect only this isolated local fixture; never open an external browser.
    await expect
      .poll(async () =>
        app?.evaluate(async ({ webContents }, url) => {
          const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
          return guest?.executeJavaScript("getComputedStyle(document.body).backgroundColor");
        }, pathToFileURL(file).href),
      )
      .toBe("rgb(18, 52, 86)");
    const guestId = await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!guest) throw new Error("Missing browser fixture");
      await guest.executeJavaScript("history.pushState({}, '', '#anchor')");
      return guest.id;
    }, pathToFileURL(file).href);
    await expect(address).toHaveValue(`${pathToFileURL(file).href}#anchor`);
    expect(
      await page
        .locator(".browser-webview")
        .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId()),
    ).toBe(guestId);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("reloading the main renderer releases native browsers and terminals", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-pane-reload-"));
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("zpi.selectedSession"))).not.toBeNull();
    const file = join(dir, "lifecycle.html");
    await writeFile(file, "<html><title>Lifecycle fixture</title></html>");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "浏览器", exact: true }).click();
    await page.getByLabel("浏览器地址").fill(file);
    await page.getByLabel("浏览器地址").press("Enter");
    await expect(page.getByRole("tab", { name: "Lifecycle fixture", exact: true })).toBeVisible();
    const guestId = await page
      .locator(".browser-webview")
      .evaluate((element) => (element as Electron.WebviewTag).getWebContentsId());
    const resources = await page.evaluate(async () => {
      const id = localStorage.getItem("zpi.selectedSession");
      if (!id) throw new Error("Missing task");
      const terminal = await window.zpi.createTerminal(id);
      if (!terminal.ok) throw new Error(terminal.error.message);
      let browserId = "";
      for (let i = 0; i < 11; i++) {
        const browser = await window.zpi.createBrowser("");
        if (!browser.ok) throw new Error(browser.error.message);
        browserId = browser.value.id;
      }
      return { terminalId: terminal.value.id, browserId };
    });
    await page.reload();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("zpi.selectedSession"))).not.toBeNull();
    expect(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .filter((window) => !window.webContents.getURL().includes("view=quick-chat"))
          .map((window) => window.contentView.children.length),
      ),
    ).toEqual([0]);
    expect(await app.evaluate(({ webContents }, id) => webContents.fromId(id) === undefined, guestId)).toBe(
      true,
    );
    const result = await page.evaluate(
      async ({ terminalId, browserId }) => ({
        terminal: await window.zpi.terminalInput(terminalId, "echo stale\n"),
        browser: await window.zpi.browserAction(browserId, "reload"),
        replacement: await window.zpi.createBrowser(""),
      }),
      resources,
    );
    expect(result.terminal).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(result.browser).toMatchObject({ ok: false, error: { code: "not_found" } });
    expect(result.replacement.ok).toBe(true);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("an exited terminal keeps its output and ignores further typing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-terminal-exit-"));
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "终端", exact: true }).click();
    const input = page.locator(".right-pane .xterm-helper-textarea");
    await expect(input).toBeAttached();
    await input.pressSequentially("exit 0");
    await input.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("[终端已退出 0]");
    await input.pressSequentially("ignored");
    await expect(page.getByRole("alert").filter({ hasText: "终端已关闭" })).toHaveCount(0);
    await expect(page.locator(".xterm-rows")).toContainText("[终端已退出 0]");
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
