import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("thinking matches ZCode: latest streaming line, completed duration and history fallback", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-thinking-preview-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "# Test project");
  const preview = `检查项目说明，${"确认配置和实现细节。".repeat(80)}`;
  const thinking = `先读取说明。\r\n${preview}\r\n \r\n`;
  const callTool = deferred();
  const finish = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(response, chunk({ reasoning_content: thinking }));
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
      send(response, chunk({ reasoning_content: "说明已读取。\n现在整理结论。\n\n" }));
      await finish.promise;
      send(response, chunk({ content: "项目说明已验证。" }));
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
    let thoughts = page.getByTestId("thinking-block");
    const summary = thoughts.first().locator(".thinking-summary");
    await expect(summary).toHaveText(preview);
    await expect(thoughts.first().getByRole("button")).toContainText("正在思考");
    await expect(thoughts.first().locator(".reasoning-duration")).toHaveCount(0);
    await expect.poll(() => summary.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    await expect(summary).toHaveAttribute("data-overflowing", "true");
    callTool.resolve();
    await expect(thoughts).toHaveCount(2);
    await expect(summary).toHaveCount(0);
    await expect(thoughts.first().getByRole("button")).toHaveText(/^思考·持续了 \d+ 秒$/);
    await expect(thoughts.last().locator(".thinking-summary")).toHaveText("现在整理结论。");
    // 手动展开后，ZCode 用“思考 + 耗时”代替运行态摘要，并保留用户选择。
    await thoughts.last().getByRole("button").click();
    await expect(thoughts.last().locator(".thinking-summary")).toHaveCount(0);
    await expect(thoughts.last().locator(".thinking-body")).toHaveText("说明已读取。\n现在整理结论。\n\n");
    await expect(thoughts.last().getByRole("button")).toHaveText(/^思考·持续了 \d+ 秒$/);
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByTestId("progress").click();
    await expect(thoughts.locator(".thinking-summary")).toHaveCount(0);
    await expect(thoughts.last().getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await expect(thoughts.last().getByRole("button")).toHaveText(/^思考·持续了 \d+ 秒$/);
    await thoughts.first().getByRole("button").click();
    await expect(thoughts.first().locator(".thinking-body")).toHaveText(thinking);
    await expect(summary).toHaveCount(0);
    await thoughts.first().getByRole("button").click();
    await expect(thoughts.first().getByRole("button")).toHaveText(/^思考·持续了 \d+ 秒$/);
    await page.screenshot({ path: "test-results/thinking-preview-completed.png" });
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    await page.getByTestId("progress").click();
    thoughts = page.getByTestId("thinking-block");
    await expect(thoughts.locator(".thinking-summary")).toHaveCount(0);
    await expect(thoughts.getByRole("button")).toHaveText(["思考·持续了几秒", "思考·持续了几秒"]);
    await expect(thoughts.getByRole("button").first()).toHaveAttribute("aria-expanded", "false");
    await thoughts.first().getByRole("button").click();
    await expect(thoughts.first().locator(".thinking-body")).toHaveText(thinking);
    await expect(thoughts.first().getByRole("button")).toHaveText("思考·持续了几秒");
  } finally {
    callTool.resolve();
    finish.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
