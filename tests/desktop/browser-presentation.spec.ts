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
    await expect(address).toHaveAttribute("placeholder", "输入");
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
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
