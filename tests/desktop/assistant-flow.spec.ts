import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("assistant prose stays in order with reasoning and tools, then only the last answer leaves history", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-assistant-flow-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "# Test project");
  const callTool = deferred();
  const finish = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(response, chunk({ reasoning_content: "先检查项目说明。" }));
      send(response, chunk({ content: "我会先**读取说明**，再给出结论。" }));
      await callTool.promise;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "readme",
              type: "function",
              function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ reasoning_content: "已经获得项目说明。" }));
      send(response, chunk({ content: "说明已经读取，正在整理结论。" }));
      send(response, chunk({ reasoning_content: "现在输出最终结论。" }));
      send(response, chunk({ content: "## 最终结论\n\n项目说明已验证。" }));
      await finish.promise;
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("检查说明");
    await page.getByLabel("发送", { exact: true }).click();
    let run = page.getByTestId("run");
    await expect(run.getByTestId("progress")).toHaveAttribute("aria-expanded", "true");
    await expect(run.locator(".process-text")).toHaveText("我会先读取说明，再给出结论。");
    await expect(run.locator(".process-text strong")).toHaveText("读取说明");
    await expect(run.locator(".assistant-message-row > .answer")).toHaveCount(0);
    // ZCode keeps running history open, even when its status label is clicked.
    await run.getByTestId("progress").click();
    await expect(run.getByTestId("process")).toBeVisible();
    callTool.resolve();
    await expect(run.locator(".process-text")).toHaveCount(3);
    expect(
      await run
        .getByTestId("process")
        .evaluate((node) =>
          Array.from(node.children, (child) =>
            child.classList.contains("process-thinking")
              ? "thinking"
              : child.classList.contains("tool-block")
                ? "tool"
                : "text",
          ),
        ),
    ).toEqual(["thinking", "text", "tool", "thinking", "text", "thinking", "text"]);
    await expect(run.locator(".process-text").last().locator("h2")).toHaveText("最终结论");
    await expect(run.getByTestId("process")).toHaveCSS("gap", "16px");
    await expect(run.getByTestId("process")).toHaveCSS("padding-top", "20px");
    await expect(run.locator(".process-text").first()).toHaveCSS("margin-top", "0px");
    const foreground = await run.locator(".user-message").evaluate((node) => getComputedStyle(node).color);
    await expect(run.locator(".process-text").first()).toHaveCSS("color", foreground);
    await page.screenshot({ path: "test-results/assistant-flow-streaming.png" });
    finish.resolve();
    await expect(run).toHaveAttribute("data-status", "completed");
    await expect(run.getByTestId("progress")).toHaveAttribute("aria-expanded", "false");
    await expect(run.getByTestId("process")).toHaveCount(0);
    await expect(run.locator(".assistant-message-row > .answer")).toHaveText(/^最终结论\s+项目说明已验证。$/);
    await expect(run.locator(".assistant-message-row > .answer")).toHaveCSS("margin-top", "20px");
    await run.locator(".assistant-message-row").hover();
    await run.locator(".assistant-message-actions").getByLabel("复制", { exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(
      "我会先**读取说明**，再给出结论。\n\n说明已经读取，正在整理结论。\n\n## 最终结论\n\n项目说明已验证。",
    );
    await run.getByTestId("progress").click();
    await expect(run.locator(".process-text")).toHaveCount(2);
    await expect(run.getByTestId("process")).not.toContainText("最终结论");
    await page.screenshot({ path: "test-results/assistant-flow-history.png" });
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    run = page.getByTestId("run");
    await expect(run.getByTestId("progress")).toHaveAttribute("aria-expanded", "false");
    await expect(run.locator(".assistant-message-row > .answer h2")).toHaveText("最终结论");
    await run.getByTestId("progress").click();
    await expect(run.locator(".process-text")).toHaveText([
      "我会先读取说明，再给出结论。",
      "说明已经读取，正在整理结论。",
    ]);
  } finally {
    callTool.resolve();
    finish.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const ending of ["completed", "aborted", "error"] as const) {
  test(`history with intermediate prose stays visible after ${ending} and restart`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ZPI-assistant-tail-"));
    const project = join(dir, "project");
    await mkdir(project);
    await writeFile(join(project, "README.md"), "# Test project");
    const finish = deferred();
    const server = await fakeServer(async (_, response, index) => {
      if (index === 0) {
        send(response, chunk({ content: "先读取说明。" }));
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "readme",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "README.md" }) },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      } else {
        send(response, chunk({ reasoning_content: "检查说明内容。" }));
        await finish.promise;
        if (ending === "error") response.destroy();
        else done(response);
      }
    });
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, project, url: server.url });
      let page = await app.firstWindow();
      await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
      await page.getByLabel("消息", { exact: true }).fill("检查说明");
      await page.getByLabel("发送", { exact: true }).click();
      let run = page.getByTestId("run");
      await expect(run.getByTestId("thinking-block")).toHaveCount(1);
      if (ending === "aborted") await page.getByLabel("停止", { exact: true }).click();
      finish.resolve();
      await expect(run).toHaveAttribute("data-status", ending);
      await expect(run.getByTestId("progress")).toHaveAttribute("aria-expanded", "true");
      await expect(run.locator(".process-text")).toHaveText("先读取说明。");
      await expect(run.locator(".assistant-message-row > .answer")).toHaveCount(0);
      await app.close();
      app = await launchDesktop({ dir, project, url: server.url });
      page = await app.firstWindow();
      run = page.getByTestId("run");
      await expect(run).toHaveAttribute("data-status", ending);
      await expect(run.getByTestId("progress")).toHaveAttribute("aria-expanded", "true");
      await expect(run.locator(".process-text")).toHaveText("先读取说明。");
    } finally {
      finish.resolve();
      await app?.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
