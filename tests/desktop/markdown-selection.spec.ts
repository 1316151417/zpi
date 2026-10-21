import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("partial identifiers and adjoining text stay selected through shortcut hint updates in both chats", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-markdown-selection-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "线上记录显示，UCID：**1000000031247413** 操作，暂未查到对应工号。" }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("查看编号");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.evaluate(async () => {
      const sessions = await window.zpi.listRecentSessions();
      if (!sessions.ok) throw new Error(sessions.error.message);
      const result = await window.zpi.setSessionPinned(sessions.value[0].id, true);
      if (!result.ok) throw new Error(result.error.message);
    });
    await page.reload();
    await expect(page.locator(".pinned-tasks [data-session-id]")).toHaveCount(1);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await side.getByLabel("消息", { exact: true }).fill("查看辅助编号");
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    for (const pane of [side, main]) {
      const paragraph = pane.locator(".answer p");
      for (const crossBoundary of [true, false]) {
        for (const backwards of [false, true]) {
          await paragraph.scrollIntoViewIfNeeded();
          const points = await paragraph.evaluate((element, crossBoundary) => {
            const number = element.querySelector("strong")?.firstChild;
            if (!number) throw new Error("Missing identifier");
            const point = (node: Node, offset: number) => {
              const range = document.createRange();
              range.setStart(node, offset);
              range.collapse(true);
              const rect = range.getBoundingClientRect();
              return { x: rect.x + 0.1, y: rect.y + rect.height / 2 };
            };
            return [point(number, 7), crossBoundary ? point(element.childNodes[2], 3) : point(number, 13)];
          }, crossBoundary);
          if (backwards) points.reverse();
          await page.mouse.move(points[0].x, points[0].y);
          await page.mouse.down();
          await page.mouse.move(points[1].x, points[1].y, { steps: 12 });
          await page.mouse.up();
          const selected = crossBoundary ? "031247413 操作" : "031247";
          const selection = () => page.evaluate(() => window.getSelection()?.toString());
          await expect.poll(selection).toBe(selected);
          const addLabel = pane === side ? "添加到当前辅助对话" : "添加到当前任务";
          await expect(
            page
              .getByRole("toolbar", { name: "选文操作" })
              .getByRole("button", { name: addLabel, exact: true }),
          ).toBeVisible();
          await page.keyboard.down(primary);
          await expect(page.locator(".pinned-tasks .task-row-shortcut")).toHaveCount(1);
          expect(await selection()).toBe(selected);
          await page.keyboard.up(primary);
          await expect(page.locator(".pinned-tasks .task-row-shortcut")).toHaveCount(0);
          expect(await selection()).toBe(selected);
          await page.evaluate(() => window.getSelection()?.removeAllRanges());
        }
      }
    }
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
