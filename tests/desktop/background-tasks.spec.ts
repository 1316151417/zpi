import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("one compact task panel manages agents and services, shows live output and dismisses only when all finish", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-panel-"));
  const server = await fakeServer((body, response) => {
    const tools = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    if (!tools.includes("Agent")) {
      send(response, chunk({ content: "Inspecting the code" }));
      return;
    }
    const messages = body.messages as { role: string; content: string }[];
    const last = messages.at(-1);
    if (
      !messages.some((message) => message.role === "tool") ||
      (last?.role === "user" && last.content === "Again")
    ) {
      const repeated = last?.content === "Again";
      const calls = [
        ...(repeated
          ? []
          : [
              {
                name: "Agent",
                args: { description: "Inspect source", prompt: "Inspect", run_in_background: true },
              },
            ]),
        {
          name: "bash",
          args: {
            command: "echo 'Server ready'; sleep 30",
            description: repeated ? "Second server" : "Dev server",
            run_in_background: true,
          },
        },
      ];
      send(
        response,
        chunk({
          tool_calls: calls.map((call, index) => ({
            index,
            id: `${repeated ? "again" : "initial"}-${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Tasks started" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(async () => {
      const result = await window.zpi.setCapabilityEnabled("subagents", true);
      if (!result.ok) throw new Error(result.error.message);
    });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("Start tasks");
    await editor.press("Enter");
    await expect(page.locator("main .answer")).toContainText("Tasks started");
    const panel = page.getByRole("complementary", { name: "任务状态", exact: true });
    await expect(panel).toHaveAttribute("data-state", "collapsed");
    await expect(panel.locator(".lucide-activity")).toBeVisible();
    await expect(panel.locator(".lucide-bot")).toHaveCount(0);
    await page.getByRole("button", { name: "展开任务状态", exact: true }).click();
    await expect(panel).toContainText("2个运行中");
    await expect(page.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "查看子智能体 Inspect source", exact: true }).click();
    await expect(page.locator(".subagent-pane")).toContainText("Inspecting the code");
    await page.getByRole("button", { name: "查看后台任务 Dev server", exact: true }).click();
    await expect(page.getByRole("region", { name: "后台任务输出", exact: true })).toContainText(
      "Server ready",
    );
    await page.screenshot({ path: test.info().outputPath("task-panel-light.png"), animations: "disabled" });
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "dark" }));
    await page.reload();
    await page.getByRole("button", { name: "展开任务状态", exact: true }).click();
    await expect(panel).toContainText("2个运行中");
    await page.screenshot({ path: test.info().outputPath("task-panel-dark.png"), animations: "disabled" });
    await page.getByRole("button", { name: "停止后台任务 Dev server", exact: true }).click();
    await expect(panel).toContainText("1个运行中");
    await expect(page.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "停止子智能体 Inspect source", exact: true }).click();
    await expect(panel).toContainText("2个已结束");
    await page.getByRole("button", { name: "关闭任务状态", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await page.getByRole("button", { name: "查看任务目录", exact: true }).click();
    await expect(page.getByRole("region", { name: "任务目录", exact: true })).toContainText("Dev server");
    await editor.fill("Again");
    await editor.press("Enter");
    await expect(panel).toBeVisible();
    // Closing the presentation never forgets task history; a new launch reveals it again.
    if (await page.getByRole("button", { name: "展开任务状态", exact: true }).count())
      await page.getByRole("button", { name: "展开任务状态", exact: true }).click();
    await panel.getByRole("button", { name: "停止后台任务 Second server", exact: true }).click();
    await expect(panel).toContainText("3个已结束");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
