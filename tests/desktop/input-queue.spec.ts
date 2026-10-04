import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { clipboardText, select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("queued messages reorder, edit, delete, send immediately and persist through stop/restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-queue-ui-"));
  const server = await fakeServer((body, res) => {
    const user =
      (body.messages as unknown as { role: string; content: string }[])
        .filter((m) => m.role === "user")
        .at(-1)?.content ?? "";
    send(res, chunk({ content: "reply" }));
    if (!user.startsWith("阻塞")) done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const a = seedHistory(dir, cwd, 1).id,
      b = seedHistory(dir, cwd, 1).id;
    const file = join(cwd, "note.txt");
    await writeFile(file, "queue reference");
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await select(page, a);
    await page.evaluate(() => window.zpi.updatePreferences({ showSendButton: true }));
    let editor = page.getByLabel("消息", { exact: true });
    await expect(page.getByLabel("发送", { exact: true })).toBeDisabled();
    await editor.fill("阻塞一");
    await expect(page.getByLabel("发送", { exact: true })).toBeEnabled();
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByLabel("停止", { exact: true })).toBeVisible();
    const canonical = `待发送一 [note.txt](${file})`;
    await editor.fill(canonical);
    await expect(page.getByLabel("加入队列", { exact: true })).toBeEnabled();
    await expect(page.getByLabel("停止", { exact: true })).toHaveCount(0);
    await page.getByLabel("加入队列", { exact: true }).click();
    await editor.fill("待发送二");
    await editor.press("Enter");
    await expect(editor).toHaveText("");
    await editor.fill("待发送三");
    await editor.press("Enter");
    const rows = page.getByTestId("queue-item");
    await expect(rows).toHaveCount(3);
    await expect(rows.locator(".queue-text")).toHaveText(["待发送一 note.txt", "待发送二", "待发送三"]);
    await expect(rows.getByLabel("拖拽排序")).toHaveCount(3);
    expect(server.requests).toHaveLength(1);
    const handle = await rows.last().getByLabel("拖拽排序").boundingBox(),
      first = await rows.first().boundingBox();
    if (!handle || !first) throw new Error("queue drag bounds");
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2, first.y + first.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect(rows.locator(".queue-text")).toHaveText(["待发送三", "待发送一 note.txt", "待发送二"]);
    await expect
      .poll(() =>
        rows.evaluateAll((nodes) => nodes.every((node) => getComputedStyle(node).transform === "none")),
      )
      .toBe(true);
    await page.screenshot({ path: "test-results/desktop-queue-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-queue-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await rows.filter({ hasText: "待发送一" }).getByLabel("编辑", { exact: true }).click();
    await expect(editor).toHaveText("待发送一 note.txt");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe(canonical);
    await editor.fill(`修改后的消息 [note.txt](${file})`);
    await editor.press("Enter");
    await expect(editor).toHaveText("");
    await rows.filter({ hasText: "待发送二" }).getByLabel("移除待发送消息", { exact: true }).click();
    await expect(rows).toHaveCount(2);
    await rows.first().getByRole("button", { name: "立即", exact: true }).click();
    await expect(rows).toHaveCount(0);
    await expect(page.getByTestId("run")).toHaveCount(4);
    await expect(page.getByTestId("run").nth(1)).toHaveAttribute("data-status", "aborted");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(server.requests).toHaveLength(3);
    await editor.fill("阻塞二");
    await editor.press("Enter");
    await expect(page.getByLabel("停止", { exact: true })).toBeVisible();
    await editor.fill("重启后继续");
    await editor.press("Enter");
    await expect(rows).toHaveCount(1);
    await select(page, b);
    await editor.fill("另一任务的草稿");
    await expect(rows).toHaveCount(0);
    await select(page, a);
    await expect(rows).toHaveCount(1);
    await page.getByLabel("停止", { exact: true }).click();
    await expect(page.locator(".queue-paused")).toContainText("由于你中断了当前响应，队列已暂停");
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    editor = page.getByLabel("消息", { exact: true });
    await expect(page.getByTestId("queue-item")).toHaveCount(1);
    await select(page, b);
    await expect(editor).toHaveText("另一任务的草稿");
    await select(page, a);
    await page.getByRole("button", { name: "继续按顺序自动发送队列中的内容", exact: true }).click();
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await editor.fill("阻塞三");
    await editor.press("Enter");
    await expect(page.getByLabel("停止", { exact: true })).toBeVisible();
    await editor.fill("应被清除的队列消息");
    await editor.press("Enter");
    await expect(page.getByTestId("queue-item")).toHaveCount(1);
    await page.getByLabel("停止", { exact: true }).click();
    await expect(page.locator(".queue-paused")).toBeVisible();
    await editor.fill("新消息");
    await editor.press("Enter");
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("要清除之前已排队的 1 条消息吗？");
    await dialog.getByRole("button", { name: "清空队列", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(editor).toHaveText("");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
