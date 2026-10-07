import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("loading keeps ZCode spacing before content, during shell execution and until the turn ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-chat-loading-"));
  const project = join(dir, "project");
  await mkdir(project);
  const prepare = deferred(),
    execute = deferred(),
    finish = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      await prepare.promise;
      // Commit the stream without adding a visible row, then expose partial shell arguments.
      send(response, chunk({ reasoning_content: "\n" }));
      send(
        response,
        chunk({
          tool_calls: [
            { index: 0, id: "shell", type: "function", function: { name: "bash", arguments: '{"command":' } },
          ],
        }),
      );
      await execute.promise;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              function: {
                arguments: '"printf started; while [ ! -f finish ]; do sleep 0.05; done"}',
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "执行完成。" }));
      await finish.promise;
      done(response);
    }
  });
  const app = await launchDesktop({ dir, project, url: server.url });
  try {
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("检查加载布局");
    await page.getByLabel("发送", { exact: true }).click();
    const run = page.getByTestId("run");
    const loading = run.locator(".chat-loading-slot");
    const gap = () =>
      loading.evaluate((el) => {
        const previous = el.previousElementSibling;
        if (!previous) throw new Error("Loading has no preceding content");
        return el.getBoundingClientRect().top - previous.getBoundingClientRect().bottom;
      });
    await expect(loading).toBeVisible();
    await expect(run.getByTestId("process")).toHaveCount(0);
    await expect.poll(gap).toBe(20);
    await expect(loading).toHaveCSS("height", "20px");
    await expect(loading.locator(".chat-loading-spinner")).toHaveCSS("width", "16px");
    await expect(loading.locator(".chat-loading-spinner")).toHaveCSS("animation-duration", "1s");
    await page.screenshot({ path: "test-results/chat-loading-waiting.png" });
    prepare.resolve();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const sessions = await window.ZPI.listRecentSessions();
          const id = sessions.ok ? sessions.value[0]?.id : undefined;
          if (!id) return "";
          const snapshot = await window.ZPI.getSessionSnapshot(id);
          const block = snapshot.ok
            ? snapshot.value.view.runs[0]?.orderedBlocks.find((item) => item.type === "tool")
            : undefined;
          return block?.type === "tool" ? block.argsText : "";
        }),
      )
      .toBe('{"command":');
    await expect(run.getByTestId("process")).toHaveCount(0);
    await expect.poll(gap).toBe(20);
    execute.resolve();
    const tool = run.getByTestId("tool-block");
    await expect(tool.getByTestId("tool-summary")).toContainText("正在执行");
    await expect(run.getByTestId("process")).toBeVisible();
    await expect.poll(gap).toBe(20);
    await page.screenshot({ path: "test-results/chat-loading-shell-collapsed.png" });
    await tool.getByTestId("tool-summary").click();
    await expect(tool.locator(".tool-output")).toHaveText("started");
    await expect.poll(gap).toBe(20);
    await page.screenshot({ path: "test-results/chat-loading-shell.png" });
    await writeFile(join(project, "finish"), "");
    await expect(run.locator(".process-text")).toHaveText("执行完成。");
    await expect(loading).toBeVisible();
    await expect.poll(gap).toBe(20);
    finish.resolve();
    await expect(run).toHaveAttribute("data-status", "completed");
    await expect(loading).toHaveCount(0);
  } finally {
    prepare.resolve();
    execute.resolve();
    finish.resolve();
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
