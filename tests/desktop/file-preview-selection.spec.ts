import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

const primary = process.platform === "darwin" ? "Meta" : "Control";

test("pinned shortcut hints preserve native text selection in file source and Markdown previews", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-preview-selection-")));
  const project = join(dir, "project");
  await mkdir(project);
  const path = join(project, "example.md");
  await writeFile(path, "# Selected preview text\n\nKeep this paragraph selected while pressing Command.\n");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[示例文件](<${path}>)` }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("显示文件");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.evaluate(async () => {
      const sessions = await window.zpi.listRecentSessions();
      if (!sessions.ok) throw new Error(sessions.error.message);
      const result = await window.zpi.setSessionPinned(sessions.value[0].id, true);
      if (!result.ok) throw new Error(result.error.message);
    });
    await page.reload();
    await expect(page.locator(".pinned-tasks [data-session-id]")).toHaveCount(1);
    await page.locator(".answer").getByRole("button", { name: "示例文件", exact: true }).click();
    const preview = page.getByRole("region", { name: "文件预览", exact: true });
    for (const [index, mode] of ["源码", "源码", "预览"].entries()) {
      await page
        .locator(".file-manager:visible")
        .getByRole("button", { name: "文件预览菜单", exact: true })
        .click();
      await page.getByRole("menuitemradio", { name: mode, exact: true }).click();
      if (index === 1) {
        await preview.locator('[data-column-number="1"]').first().click();
        await preview.getByLabel("代码备注", { exact: true }).fill("Keep the annotation while copying");
        await preview.getByRole("button", { name: /添加到对话/ }).click();
        await expect(preview.locator("[data-file-comment-id]")).toHaveCount(1);
      }
      const text = preview.locator(mode === "源码" ? '[data-line="1"]' : ".file-markdown-preview h1").first();
      await expect(text).toContainText("Selected preview text");
      await text.click();
      const selected = await text.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        return selection?.toString();
      });
      expect(selected).toContain("Selected preview text");
      await page.keyboard.down(primary);
      await expect(page.locator(".pinned-tasks .task-row-shortcut")).toHaveCount(1);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
      await page.keyboard.up(primary);
      await expect(page.locator(".pinned-tasks .task-row-shortcut")).toHaveCount(0);
      expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(selected);
      await page.evaluate(() => window.getSelection()?.removeAllRanges());
    }
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
