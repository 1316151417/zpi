import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("native terminal shell, browser link/navigation isolation, tabs and responsive pane bounds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-native-panes-"));
  await writeFile(join(dir, ".zshrc"), "PROMPT='ZPI> '\n");
  let recovered = false;
  const site = createServer((request, response) => {
    if (request.url === "/recover" && !recovered) {
      response.destroy();
      return;
    }
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(
      `<html><title>${request.url === "/next" ? "第二页" : "本地预览"}</title><body><h1>${request.url}</h1><a href="/next">下一页</a><p>native browser test</p></body></html>`,
    );
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const model = await fakeServer((_, response) => {
    send(response, chunk({ content: `[本地预览](${url}/)` }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: model.url });
    const page = await app.firstWindow();
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "终端", exact: true }).click();
    const input = page.locator(".right-pane .xterm-helper-textarea");
    await expect(input).toBeAttached();
    await input.pressSequentially("printf 'ZPI_TERMINAL_%s\\n' 'OK'; pwd; stty size", { delay: 2 });
    await input.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("ZPI_TERMINAL_OK");
    await expect(page.locator(".xterm-rows")).toContainText("workspace");
    const terminalColor = () => page.locator(".xterm-rows").evaluate((el) => getComputedStyle(el).color);
    await page.emulateMedia({ colorScheme: "light" });
    const lightTerminal = await terminalColor();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const appearance = page.getByRole("region", { name: "设置", exact: true });
    await appearance.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await appearance.getByRole("spinbutton", { name: "界面字号", exact: true }).fill("16");
    await appearance.getByRole("spinbutton", { name: "界面字号", exact: true }).press("Enter");
    await appearance.getByLabel("关闭设置").click();
    await expect.poll(terminalColor).not.toBe(lightTerminal);
    await expect
      .poll(() => page.locator(".xterm-rows").evaluate((el) => getComputedStyle(el).fontSize))
      .toBe("14px");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await appearance.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "浅色", exact: true }).click();
    await appearance.getByRole("spinbutton", { name: "界面字号", exact: true }).fill("14");
    await appearance.getByRole("spinbutton", { name: "界面字号", exact: true }).press("Enter");
    await appearance.getByLabel("关闭设置").click();
    await expect.poll(terminalColor).toBe(lightTerminal);
    await page.screenshot({ path: "test-results/desktop-terminal.png" });
    await page.getByLabel("消息", { exact: true }).fill("生成链接");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await page.locator(".answer").getByRole("button", { name: "本地预览", exact: true }).click();
    await expect(page.getByLabel("浏览器地址")).toHaveValue(`${url}/`);
    await expect(page.getByRole("tab", { name: "本地预览", exact: true })).toBeVisible();
    const inspect = () =>
      app?.evaluate(async ({ webContents, BrowserWindow, WebContentsView }, url) => {
        const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url));
        if (!guest) return null;
        return {
          url: guest.getURL(),
          bounds: BrowserWindow.getAllWindows()[0]
            ?.contentView.children.filter(
              (child) => child instanceof WebContentsView && child.webContents.id === guest.id,
            )
            .map((child) => child.getBounds()),
          isolated: await guest.executeJavaScript("[typeof window.ZPI, typeof require, typeof process]"),
        };
      }, url);
    await expect
      .poll(async () => (await inspect())?.isolated)
      .toEqual(["undefined", "undefined", "undefined"]);
    await expect(page.getByLabel("刷新页面")).toBeVisible();
    await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL() === `${url}/`);
      await guest?.executeJavaScript("document.querySelector('a').click()");
    }, url);
    await expect(page.getByLabel("浏览器地址")).toHaveValue(`${url}/next`);
    await page.screenshot({ path: "test-results/desktop-browser-before-back.png" });
    await page.getByLabel("浏览器后退").click();
    await expect(page.getByLabel("浏览器地址")).toHaveValue(`${url}/`);
    await page.getByLabel("浏览器前进").click();
    await expect(page.getByLabel("浏览器地址")).toHaveValue(`${url}/next`);
    await page.getByLabel("刷新页面").click();
    await page.getByLabel("浏览器地址").fill(`${url}/recover`);
    await page.getByLabel("浏览器地址").press("Enter");
    await expect(page.locator(".browser-pane [role=alert]")).toBeVisible();
    recovered = true;
    await page.getByLabel("刷新页面").click();
    await expect(page.locator(".browser-pane [role=alert]")).toHaveCount(0);
    await expect(page.getByRole("tab", { name: "本地预览", exact: true })).toBeVisible();
    const invalid = await page.evaluate(() => window.ZPI.createBrowser("file://remote-host/share/page.html"));
    expect(invalid.ok).toBe(false);
    const invalidNavigation = await page.evaluate(async () => {
      const blank = await window.ZPI.createBrowser("");
      if (!blank.ok) throw Error(blank.error.message);
      const rejected = await window.ZPI.browserAction(blank.value.id, "navigate", "javascript:alert(1)");
      await window.ZPI.closeBrowser(blank.value.id);
      return rejected;
    });
    expect(invalidNavigation).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    await page.getByLabel("模型选择", { exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(1);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(1);
    await page.getByRole("menuitem", { name: "fake", exact: true }).hover();
    await expect(page.getByRole("menu")).toHaveCount(2);
    await expect
      .poll(() =>
        page.getByRole("menu").evaluateAll((menus) => {
          const main = document.querySelector("main")?.getBoundingClientRect();
          return main && menus.every((menu) => menu.getBoundingClientRect().right <= main.right);
        }),
      )
      .toBe(true);
    await page.evaluate(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))),
    );
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(1);
    await page.getByRole("menuitem", { name: "关闭", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(1);
    // A menu over the native surface must still remain accessible, including after repositioning.
    await page.evaluate(() => {
      const surface = document.querySelector('[data-testid="browser-surface"]')?.getBoundingClientRect();
      if (!surface) throw Error("Missing browser surface");
      const menu = document.createElement("div");
      menu.id = "overlapping-menu";
      menu.setAttribute("role", "menu");
      Object.assign(menu.style, {
        position: "fixed",
        left: `${surface.left + 20}px`,
        top: `${surface.top + 20}px`,
        width: "100px",
        height: "100px",
      });
      document.body.append(menu);
    });
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(0);
    await page.evaluate(() => {
      const menu = document.getElementById("overlapping-menu");
      if (menu) menu.style.left = "0px";
    });
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(1);
    await page.evaluate(() => document.getElementById("overlapping-menu")?.remove());
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(0);
    await page.getByRole("region", { name: "设置", exact: true }).getByLabel("关闭设置").click();
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(1);
    // Native views do not obey CSS overflow: reopening must clip them to the moving frame.
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeHidden();
    const movingFrame = await page.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('[data-testid="right-sidebar-toggle"]')?.click();
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const panel = document.querySelector(".right-pane");
      for (const animation of panel?.getAnimations() ?? []) {
        animation.pause();
        animation.currentTime = 100;
      }
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      const clip = document.querySelector(".right-pane-frame")?.getBoundingClientRect();
      if (!clip) throw Error("Missing browser clip frame");
      return { left: clip.left, right: clip.right, width: clip.width };
    });
    const movingBrowser = (await inspect())?.bounds?.[0];
    await page.evaluate(() => {
      for (const animation of document.querySelector(".right-pane")?.getAnimations() ?? []) animation.play();
    });
    expect(movingBrowser).toBeDefined();
    expect(movingBrowser?.x).toBeGreaterThanOrEqual(Math.floor(movingFrame.left));
    expect((movingBrowser?.x ?? 0) + (movingBrowser?.width ?? 0)).toBeLessThanOrEqual(
      Math.ceil(movingFrame.right),
    );
    expect(movingBrowser?.width).toBeLessThanOrEqual(movingFrame.width);
    await expect(page.locator(".right-pane")).not.toHaveAttribute("data-animating", "true");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(900, 640));
    await expect
      .poll(async () => {
        const data = await inspect();
        const bound = data?.bounds?.[0];
        return Boolean(
          bound &&
            bound.x >= 0 &&
            bound.y >= 0 &&
            bound.x + bound.width <= 900 &&
            bound.y + bound.height <= 640,
        );
      })
      .toBe(true);
    await page.screenshot({ path: "test-results/desktop-browser-narrow.png" });
    // Renderer screenshots omit native child views; capture their real pixels separately.
    const browserPixels = await app.evaluate(async ({ webContents }, url) => {
      const guest = webContents.getAllWebContents().find((contents) => contents.getURL().startsWith(url));
      if (!guest) throw Error("Missing native browser page");
      return (await guest.capturePage()).toPNG().toString("base64");
    }, url);
    await writeFile("test-results/desktop-browser-page.png", Buffer.from(browserPixels, "base64"));
    await page.getByRole("tab", { name: "zsh", exact: true }).click();
    await expect(page.locator(".xterm-rows")).toContainText("ZPI_TERMINAL_OK");
    await page.getByLabel("收起右侧栏", { exact: true }).last().click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect.poll(async () => (await inspect())?.bounds?.length).toBe(0);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.getByLabel("关闭标签 zsh", { exact: true }).click();
    await expect(page.getByRole("tab", { name: "zsh", exact: true })).toHaveCount(0);
  } finally {
    await app?.close();
    await model.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test("local HTML links and address-bar paths load sandboxed pages, assets and relative navigation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-file-browser-"));
  const project = join(dir, "中文 项目");
  await mkdir(project);
  const file = join(project, "本地 页面.html");
  const url = `${pathToFileURL(file).href}?preview=1#start`;
  await writeFile(
    file,
    '<html><title>本地文件预览</title><link rel="stylesheet" href="style.css"><body><h1 id="start">本地 HTML</h1><a href="next.html">下一页</a><script src="app.js"></script></body></html>',
  );
  await writeFile(join(project, "style.css"), "h1 { color: rgb(32, 96, 128); }");
  await writeFile(join(project, "app.js"), "document.body.dataset.ready = 'local-script';");
  await writeFile(join(project, "next.html"), "<html><title>本地第二页</title><body>第二页</body></html>");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[打开本地页面](${url})` }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("打开本地文件");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await page.locator(".answer").getByRole("button", { name: "打开本地页面" }).click();
    await expect(page.getByLabel("浏览器地址")).toHaveValue(url);
    await expect(page.getByRole("tab", { name: "本地文件预览", exact: true })).toBeVisible();
    const inspect = () =>
      app?.evaluate(async ({ webContents }, prefix) => {
        const guest = webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix));
        return guest
          ? guest.executeJavaScript(
              "[document.body.dataset.ready, getComputedStyle(document.querySelector('h1')).color, typeof window.ZPI, typeof require, typeof process]",
            )
          : null;
      }, pathToFileURL(file).href);
    await expect
      .poll(inspect)
      .toEqual(["local-script", "rgb(32, 96, 128)", "undefined", "undefined", "undefined"]);
    await app.evaluate(async ({ webContents }, prefix) => {
      const guest = webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix));
      await guest?.executeJavaScript("document.querySelector('a').click()");
    }, pathToFileURL(file).href);
    await expect(page.getByLabel("浏览器地址")).toHaveValue(pathToFileURL(join(project, "next.html")).href);
    await page.getByLabel("浏览器后退").click();
    await expect(page.getByLabel("浏览器地址")).toHaveValue(url);
    await page.getByLabel("浏览器前进").click();
    await expect(page.getByLabel("浏览器地址")).toHaveValue(pathToFileURL(join(project, "next.html")).href);
    await page.getByLabel("浏览器地址").fill(file);
    await page.getByLabel("浏览器地址").press("Enter");
    await expect(page.getByLabel("浏览器地址")).toHaveValue(pathToFileURL(file).href);
    await expect
      .poll(inspect)
      .toEqual(["local-script", "rgb(32, 96, 128)", "undefined", "undefined", "undefined"]);
    await page.getByLabel("浏览器地址").fill(pathToFileURL(file).href.replace("file:///", "file///"));
    await page.getByLabel("浏览器地址").press("Enter");
    await expect(page.getByLabel("浏览器地址")).toHaveValue(pathToFileURL(file).href);
    const pixels = await app.evaluate(async ({ webContents }, prefix) => {
      const guest = webContents.getAllWebContents().find((c) => c.getURL().startsWith(prefix));
      if (!guest) throw Error("Missing local page");
      return (await guest.capturePage()).toPNG().toString("base64");
    }, pathToFileURL(file).href);
    await writeFile("test-results/desktop-local-browser.png", Buffer.from(pixels, "base64"));
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

test("reasoning submenu keeps the native browser visible with long model names and a wide sidebar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-reasoning-pane-"));
  await mkdir(join(dir, "workspace"));
  const file = join(dir, "workspace", "preview.html");
  await writeFile(
    file,
    '<html><meta charset="utf-8"><title>菜单预览</title><body>Browser stays visible</body></html>',
  );
  const url = pathToFileURL(file).href;
  const app = await launchDesktop({ dir, url: "" });
  try {
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const result = await window.ZPI.saveProvider({
        id: "menu-fixture",
        name: "菜单测试",
        baseUrl: "http://127.0.0.1:1",
        apiKey: "fake",
        models: [
          {
            id: "model",
            name: "测试模型名称较长时思考级别菜单仍应保持浏览器可见",
            reasoning: true,
            input: ["text"],
          },
        ],
      });
      if (!result.ok) throw Error(result.error.message);
    });
    await page.reload();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "浏览器", exact: true }).click();
    await page.getByLabel("浏览器地址").fill(url);
    await page.getByLabel("浏览器地址").press("Enter");
    await expect(page.getByRole("tab", { name: "菜单预览", exact: true })).toBeVisible();
    const attached = () =>
      app.evaluate(
        ({ BrowserWindow, WebContentsView }, url) =>
          BrowserWindow.getAllWindows()[0]?.contentView.children.filter(
            (child) => child instanceof WebContentsView && child.webContents.getURL() === url,
          ).length,
        url,
      );
    for (let i = 0; i < 9; i++) await page.getByLabel("右侧栏宽度", { exact: true }).press("ArrowLeft");
    for (const width of [1200, 1100]) {
      await app.evaluate(
        ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0]?.setSize(width, 800),
        width,
      );
      await expect.poll(attached).toBe(1);
      await page.getByLabel("模型选择", { exact: true }).click();
      await page
        .getByRole("menuitem", { name: "测试模型名称较长时思考级别菜单仍应保持浏览器可见", exact: true })
        .hover();
      await expect(page.getByRole("menu")).toHaveCount(2);
      await expect.poll(attached).toBe(1);
      await expect
        .poll(() =>
          page.getByRole("menu").evaluateAll((menus) => {
            const surface = document
              .querySelector('[data-testid="browser-surface"]')
              ?.getBoundingClientRect();
            const main = document.querySelector("main")?.getBoundingClientRect();
            return (
              surface &&
              main &&
              menus.every((menu) => {
                const rect = menu.getBoundingClientRect();
                return rect.left >= main.left && rect.right <= surface.left;
              })
            );
          }),
        )
        .toBe(true);
      await page.getByRole("menuitem", { name: "高", exact: true }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);
      await expect.poll(attached).toBe(1);
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
