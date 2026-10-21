import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

// Playwright covers native-window focus, but injects text through CDP. Also verify
// system typing after gutter activation: DOM focus alone does not prove macOS IME readiness.
test("interactive: source comments accept typing in a focused native window", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-native-comment-focus-")));
  const project = join(dir, "project");
  await mkdir(project);
  const path = join(project, "hello.md");
  await writeFile(path, "# Hello\n\nThis is a sample file.\n\n- Created today\n- Comment here\n\n## Code\n");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[hello.md](<${path}>)` }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    await app.evaluate(({ app, BrowserWindow }) => {
      app.focus({ steal: true });
      BrowserWindow.getAllWindows()[0].focus();
    });
    await expect.poll(() => page.evaluate(() => document.hasFocus())).toBe(true);
    const main = page.locator("main");
    const composer = main.getByLabel("消息", { exact: true });
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await composer.fill("显示文件");
    await composer.press("Enter");
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await composer.fill("keep main draft");
    await main.locator(".answer").getByRole("button", { name: "hello.md", exact: true }).click();
    const manager = page.locator(".file-manager:visible");
    await manager.getByRole("button", { name: "文件预览菜单", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "源码", exact: true }).click();
    const preview = manager.getByRole("region", { name: "文件预览", exact: true });
    const comment = preview.getByLabel("代码备注", { exact: true });
    for (const line of [6, 3, 6]) {
      await preview.locator(`[data-column-number="${line}"]`).first().hover();
      await preview.locator("[data-utility-button]").click({ delay: 150 });
      await expect(comment).toBeVisible();
      await page.keyboard.type("native input");
      await expect(comment).toHaveValue("native input");
      await expect(comment).toBeFocused();
      await expect(composer).toHaveText("keep main draft");
      await page.keyboard.press("Escape");
      await expect(comment).toHaveCount(0);
    }
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
