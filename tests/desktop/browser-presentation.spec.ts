import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { done, fakeServer } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

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
    await app.evaluate(async ({ BrowserWindow, webContents }, url) => {
      const host = BrowserWindow.getAllWindows().find(
        (window) => !window.webContents.getURL().includes("view=quick-chat"),
      );
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === url);
      if (!host || !guest) throw new Error("Missing browser fixture");
      const remove = host.contentView.removeChildView.bind(host.contentView);
      const state = { removed: 0 };
      Object.assign(globalThis, { browserDetachState: state });
      host.contentView.removeChildView = (view) => {
        state.removed++;
        remove(view);
      };
      await guest.executeJavaScript("history.pushState({}, '', '#anchor')");
    }, pathToFileURL(file).href);
    await expect(address).toHaveValue(`${pathToFileURL(file).href}#anchor`);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    expect(
      await app.evaluate(
        () =>
          (globalThis as unknown as { browserDetachState: { removed: number } }).browserDetachState.removed,
      ),
    ).toBe(0);
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
    const resources = await page.evaluate(async () => {
      const id = localStorage.getItem("zpi.selectedSession");
      if (!id) throw new Error("Missing task");
      const terminal = await window.zpi.createTerminal(id);
      if (!terminal.ok) throw new Error(terminal.error.message);
      let browserId = "";
      for (let i = 0; i < 12; i++) {
        const browser = await window.zpi.createBrowser("");
        if (!browser.ok) throw new Error(browser.error.message);
        browserId = browser.value.id;
      }
      await window.zpi.browserBounds(browserId, { x: 0, y: 0, width: 100, height: 100 });
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
