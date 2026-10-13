import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { emptyAssistant, type ToolCall } from "zpi-ai";
import { piTemplate, SessionManager } from "zpi-coding-agent";
import { defaultCapabilities } from "../../packages/desktop/src/shared/config.ts";
import { fakeModel } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("process summaries retain ZCode typography and single-line geometry when the right pane opens", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-process-summary-layout-"));
  const summary = "Count lines of code in snake.html and report the function statistics";
  const target = "agent_adfa8c3b-47e3-4296-a36a-95be27217598";
  const taskId = "exec_85d164be-c9fb-40b4-9806-499e0c708043";
  const command = 'lsof -nP -iTCP:8080 -sTCP:LISTEN 2>/dev/null || echo "port 8080 free"';
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const manager = SessionManager.create(cwd, join(dir, "agent", "sessions", "_unassigned"));
  manager.appendSessionInfo("过程摘要布局");
  manager.appendCustomEntry("zpi.configuration", {
    template: { ...piTemplate },
    disabledSkillPaths: [],
    ...defaultCapabilities,
  });
  manager.appendCustomEntry("zpi.session_meta", { projectId: null, pinnedAt: null });
  manager.appendCustomEntry("zpi.title", { state: "legacy" });
  manager.appendModelChange("custom", "fake");
  manager.appendCustomEntry("zpi.run", {
    phase: "start",
    runId: "layout",
    text: "检查过程摘要",
    startedAt: Date.now() - 6000,
    modelLabel: "Fake",
  });
  manager.appendMessage({ role: "user", content: "检查过程摘要", timestamp: Date.now() });
  const tools: ToolCall[] = [
    {
      type: "toolCall",
      id: "message",
      name: "SendMessage",
      arguments: { summary, to: target, message: "完整消息内容" },
    },
    { type: "toolCall", id: "output", name: "TaskOutput", arguments: { task_id: taskId } },
    { type: "toolCall", id: "stop", name: "TaskStop", arguments: { task_id: taskId } },
    { type: "toolCall", id: "bash", name: "bash", arguments: { command } },
  ];
  const assistant = emptyAssistant(fakeModel("http://127.0.0.1:1/v1"));
  manager.appendMessage({
    ...assistant,
    content: [{ type: "thinking", thinking: "先检查摘要的布局。" }, ...tools],
    stopReason: "toolUse",
  });
  for (const tool of tools) {
    manager.appendMessage({
      role: "toolResult",
      toolCallId: tool.id,
      toolName: tool.name,
      content: [
        {
          type: "text",
          text:
            tool.name === "TaskOutput"
              ? `<retrieval_status>success</retrieval_status>\n\n<task_id>${taskId}</task_id>\n\n<task_type>local_bash</task_type>\n\n<status>aborted</status>\n\n<output>\n任务输出正文\n</output>`
              : tool.name === "TaskStop"
                ? JSON.stringify({ command, message: "任务已停止" })
                : "完成",
        },
      ],
      isError: false,
      timestamp: Date.now(),
    });
  }
  manager.appendMessage({ ...assistant, content: [{ type: "text", text: "检查完成。" }] });
  manager.appendCustomEntry("zpi.run", {
    phase: "end",
    runId: "layout",
    status: "completed",
    endedAt: Date.now(),
  });
  const app = await launchDesktop({ dir, url: "http://127.0.0.1:1/v1" });
  try {
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 900));
    const main = page.locator("main");
    await page.locator(`.session-row[data-session-id="${manager.getSessionId()}"]`).click();
    const rows = main.locator(".block-toggle, .tool-summary-row");
    const measure = () =>
      rows.evaluateAll((elements) =>
        elements.map((element) => ({
          fontSize: getComputedStyle(element).fontSize,
          height: element.getBoundingClientRect().height,
          iconWidth: element.querySelector("svg")?.getBoundingClientRect().width,
          labelWeight: getComputedStyle(element.querySelector("strong") as Element).fontWeight,
          overflow: element.scrollWidth - element.clientWidth,
        })),
      );
    for (const fontSize of [14, 18]) {
      for (const theme of ["light", "dark"] as const) {
        await page.evaluate((preferences) => window.zpi.updatePreferences(preferences), { theme, fontSize });
        await page.reload();
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        await main.getByTestId("progress").click();
        await expect(rows).toHaveCount(5);
        await expect(rows.first()).toHaveCSS("font-size", `${fontSize}px`);
        const wide = await measure();
        await page.getByLabel("展开右侧栏", { exact: true }).click();
        await expect(page.locator(".right-pane")).toBeVisible();
        await expect(page.locator(".right-pane")).not.toHaveAttribute("data-animating", "true");
        for (const width of [1200, 900]) {
          await app.evaluate(
            ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
            width,
          );
          await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
          const narrow = await measure();
          expect(narrow).toEqual(wide);
          expect(
            narrow.every((row) => row.iconWidth === 16 && row.labelWeight === "500" && row.overflow <= 1),
          ).toBe(true);
          await page.screenshot({
            path: test.info().outputPath(`process-${fontSize}-${theme}-${width}.png`),
          });
        }
        const message = main.locator('[data-tool-name="SendMessage"]');
        await message.getByRole("button", { name: "展开工具详情" }).click();
        await expect(message.locator("dd")).toHaveText([target, summary, "完整消息内容"]);
        await message.getByRole("button", { name: "收起工具详情" }).click();
        for (const name of ["TaskOutput", "TaskStop"]) {
          const tool = main.locator(`[data-tool-name="${name}"]`);
          await tool.getByRole("button", { name: "展开工具详情" }).click();
          await expect(tool.locator(".subagent-task-output")).toContainText(
            name === "TaskOutput" ? "任务输出正文" : command,
          );
          await tool.getByRole("button", { name: "收起工具详情" }).click();
        }
        await page.getByLabel("收起右侧栏", { exact: true }).click();
        await expect(page.locator(".right-pane")).toBeHidden();
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 900));
      }
    }
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
