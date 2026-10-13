import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("subagent plugin manages profiles/models and opens complete read-only child status in an isolated side tab", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-subagents-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((body, response) => {
    const names = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    const rows = body.messages as { role: string; content: string }[];
    if (!names.includes("Agent")) {
      send(response, chunk({ content: "Full child research result\n\nInspected project files." }));
      done(response);
      return;
    }
    if (!rows.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "explore",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  description: "Inspect project files",
                  subagent_type: "Explore",
                  prompt: "Find entry points",
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Parent task report" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "子智能体", exact: true })).not.toBeChecked();
    await expect(page.getByRole("region", { name: "子智能体管理" })).toHaveCount(0);
    await page.getByRole("button", { name: "子智能体", exact: true }).click();
    await expect(page.getByTestId("subagent-row-general-purpose")).toBeVisible();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    await page.getByRole("checkbox", { name: "子智能体", exact: true }).check();
    await expect(page.getByRole("region", { name: "子智能体管理" })).toHaveCount(0);
    await page.getByRole("button", { name: "子智能体", exact: true }).click();
    await expect(page.getByTestId("subagent-row-general-purpose")).toBeVisible();
    await expect(page.getByTestId("subagent-row-Explore")).toBeVisible();
    await expect(
      page.getByTestId("subagent-row-general-purpose").locator("[data-agent-color=blue]"),
    ).toBeVisible();
    await expect(page.getByTestId("subagent-row-Explore").locator("[data-agent-color=cyan]")).toBeVisible();
    await page.getByTestId("subagent-row-Explore").getByLabel("子智能体模型").click();
    await page.getByRole("menuitem").filter({ hasText: "fake" }).click();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const r = await window.zpi.listSubagents(null);
          return r.ok
            ? r.value.agents.find((agent) => agent.name === "Explore")?.modelSelection?.modelId
            : undefined;
        }),
      )
      .toBe("fake");
    await expect(page.locator(".subagent-model-menu")).toBeHidden();
    await page.getByTestId("subagent-row-Explore").getByLabel("子智能体模型").click();
    await page.getByRole("menuitem", { name: "继承默认", exact: true }).click();
    await page.getByRole("button", { name: "新建", exact: true }).first().click();
    await page.getByLabel("子智能体名称", { exact: true }).fill("code-reviewer");
    await page.getByLabel("子智能体描述", { exact: true }).fill("Review requested code");
    await page.getByLabel("子智能体系统提示词", { exact: true }).fill("Review only the requested code.");
    await page.getByRole("radio", { name: "purple", exact: true }).check();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(page.getByTestId("subagent-row-code-reviewer")).toBeVisible();
    const row = page.getByTestId("subagent-row-code-reviewer");
    const geometry = await row.evaluate((element) => ({
      padding: getComputedStyle(element).padding,
      avatar: element.querySelector(".subagent-avatar")?.getBoundingClientRect().width,
    }));
    expect(geometry).toEqual({ padding: "12px 16px", avatar: 36 });
    await row.getByRole("button", { name: "删除 code-reviewer", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "删除子智能体" })).toContainText("此操作无法撤销");
    await page.getByRole("dialog", { name: "删除子智能体" }).getByRole("button", { name: "取消" }).click();
    await expect(row).toBeVisible();
    const profilePath = await page.evaluate(async () => {
      const result = await window.zpi.listSubagents(null);
      return result.ok
        ? result.value.agents.find((agent) => agent.name === "code-reviewer")?.path
        : undefined;
    });
    const originalProfile = await readFile(profilePath as string, "utf8");
    await writeFile(
      profilePath as string,
      originalProfile.replace("model: inherit", "model: custom/removed"),
    );
    await page.getByRole("button", { name: "刷新", exact: true }).click();
    await row.click();
    await expect(page.getByRole("button", { name: "子智能体模型", exact: true })).toContainText("选择模型");
    await expect(page.getByRole("button", { name: "保存", exact: true })).toBeDisabled();
    await expect(page.getByLabel("子智能体推理档位")).toHaveCount(0);
    await page.getByRole("button", { name: "子智能体模型", exact: true }).click();
    await page.getByRole("menuitem", { name: "继承默认", exact: true }).click();
    await page.getByRole("button", { name: "保存", exact: true }).click();
    await expect(row).toBeVisible();
    await page.screenshot({ path: test.info().outputPath("subagent-settings.png"), animations: "disabled" });
    await page.getByRole("button", { name: "界面设置", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.getByRole("button", { name: "子智能体", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    const darkDot = await page
      .getByTestId("subagent-row-Explore")
      .locator("[data-agent-color=cyan]")
      .evaluate((element) => getComputedStyle(element).backgroundColor);
    expect(darkDot).toMatch(/0\.32|32%/);
    await page.screenshot({
      path: test.info().outputPath("subagent-settings-dark.png"),
      animations: "disabled",
    });
    await page.getByRole("button", { name: "界面设置", exact: true }).click();
    await page.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "浅色", exact: true }).click();
    await page.getByRole("button", { name: "关闭设置", exact: true }).click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("Inspect this project with Explore");
    await editor.press("Enter");
    await expect(page.locator("main .answer")).toContainText("Parent task report");
    await page.locator("main").getByTestId("progress").first().click();
    await page.getByRole("button", { name: "在侧栏查看 Inspect project files", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Inspect project files", exact: true })).toBeVisible();
    await expect(page.getByRole("region", { name: "子智能体详情", exact: true })).toContainText(
      "Full child research result",
    );
    await expect(page.locator(".subagent-pane-header")).toHaveCount(0);
    await expect(page.locator(".subagent-pane [contenteditable=true]")).toHaveCount(0);
    await expect(page.locator(".sidebar")).not.toContainText("Inspect project files");
    await page.screenshot({ path: test.info().outputPath("subagent-details.png"), animations: "disabled" });
    const childId = await page.locator("[data-subagent-session]").getAttribute("data-subagent-session");
    await page.getByRole("button", { name: "关闭标签 Inspect project files", exact: true }).click();
    expect(
      await page.evaluate(async (id) => {
        const r = await window.zpi.getSessionSnapshot(id as string);
        return r.ok ? r.value.view.runs.length : 0;
      }, childId),
    ).toBe(1);
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(page.locator(".right-pane")).toBeHidden();
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("background child streams into the side pane, updates status live and returns a readable notification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-subagents-live-"));
  let childResponse: import("node:http").ServerResponse | undefined;
  const server = await fakeServer((body, response) => {
    const names = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    const rows = body.messages as { role: string; content: string }[];
    if (!names.includes("Agent")) {
      childResponse = response;
      send(response, chunk({ content: "Live child progress" }));
      return;
    }
    if (!rows.some((message) => message.role === "tool") || rows.at(-1)?.content === "Run research again") {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "background",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  description: "Background research",
                  prompt: "Inspect asynchronously",
                  run_in_background: true,
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Coordinator report" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.evaluate(async () => {
      const result = await window.zpi.setCapabilityEnabled("subagents", true);
      if (!result.ok) throw new Error(result.error.message);
    });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("Start background research");
    await editor.press("Enter");
    await expect(page.locator("main .answer")).toContainText("Coordinator report");
    await expect(page.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await expect(page.locator(".composer-container .task-activity")).toHaveCount(0);
    const geometry = await page.locator(".task-activity").evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const body = element.closest(".task-body")?.getBoundingClientRect();
      return {
        top: panel.top - (body?.top ?? 0),
        right: (body?.right ?? 0) - panel.right,
        width: panel.width,
        height: panel.height,
      };
    });
    expect(geometry.top).toBe(16);
    expect(geometry.right).toBe(16);
    expect(geometry.width).toBe(32);
    expect(geometry.height).toBe(32);
    await page.screenshot({
      path: test.info().outputPath("task-activity-collapsed.png"),
      animations: "disabled",
    });
    await page.locator(".task-activity-toggle").click();
    await expect(page.getByRole("button", { name: "收起任务状态", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "收起任务状态", exact: true }).click();
    await expect(page.locator(".task-activity-list")).toHaveCount(0);
    await page.getByRole("button", { name: "展开任务状态", exact: true }).click();
    await page.screenshot({
      path: test.info().outputPath("task-activity-light.png"),
      animations: "disabled",
    });
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "dark" }));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator(".task-activity-toggle").click();
    await page.screenshot({
      path: test.info().outputPath("task-activity-dark.png"),
      animations: "disabled",
    });
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "light" }));
    await page.reload();
    await page.locator(".task-activity-toggle").click();
    await page.getByRole("button", { name: "查看子智能体 Background research", exact: true }).click();
    await expect(page.locator(".subagent-pane")).toContainText("Live child progress");
    await expect(page.locator(".task-activity-toggle")).toContainText("1个运行中");
    send(
      childResponse as import("node:http").ServerResponse,
      chunk({ content: "\nCompleted child findings" }),
    );
    done(childResponse as import("node:http").ServerResponse);
    await expect(page.locator(".subagent-pane")).toContainText("Completed child findings");
    await expect(page.locator(".task-activity-toggle")).toContainText("1个已结束");
    await expect(page.locator("main .answer")).toHaveCount(2);
    await expect(page.locator("main .subagent-result-notice")).toHaveCount(0);
    await expect(page.locator("main .user-message")).not.toContainText("<task-notification>");
    await page.getByRole("button", { name: "关闭标签 Background research", exact: true }).click();
    await page.locator(".task-ended").click();
    await expect(page.locator(".task-directory")).toContainText("已完成");
    await page
      .locator(".task-directory")
      .getByRole("button", { name: /Background research/ })
      .click();
    await expect(page.locator(".subagent-pane")).toContainText("Completed child findings");
    await page.getByRole("button", { name: "关闭任务状态", exact: true }).click();
    await expect(page.locator(".task-activity")).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("button", { name: "查看任务目录", exact: true })).toBeVisible();
    await expect(page.locator(".task-activity")).toHaveCount(0);
    await page.getByRole("button", { name: "查看任务目录", exact: true }).click();
    await expect(page.locator(".task-directory:visible")).toContainText("已完成");
    await editor.fill("Run research again");
    await editor.press("Enter");
    await expect(page.locator(".task-activity-toggle")).toContainText("1个运行中");
    await page.locator(".task-activity-toggle").click();
    await page
      .locator(".task-activity")
      .getByRole("button", { name: "停止子智能体 Background research", exact: true })
      .click();
    await expect(page.locator(".task-activity-toggle")).toContainText("2个已结束");
    await page.getByRole("button", { name: "关闭任务状态", exact: true }).click();
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await editor.fill("Start another background task");
    await editor.press("Enter");
    await expect(page.locator("main .answer")).toContainText("Coordinator report");
    await page.locator(".task-activity-toggle").click();
    await page.getByRole("button", { name: "查看子智能体 Background research", exact: true }).click();
    await expect(page.locator(".task-activity-toggle")).toContainText("1个运行中");
    await page
      .locator(".task-activity")
      .getByRole("button", { name: "停止子智能体 Background research", exact: true })
      .click();
    await page.locator(".task-ended").click();
    await expect(page.locator(".task-directory:visible")).toContainText("已停止");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("TaskOutput waits for the child and shows a clean result without duplicate completion turns", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-subagents-output-"));
  let childResponse: import("node:http").ServerResponse | undefined;
  const server = await fakeServer((body, response) => {
    const names = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    const rows = body.messages as { role: string; content: string }[];
    if (!names.includes("Agent")) {
      childResponse = response;
      return;
    }
    const lastTool = rows.filter((row) => row.role === "tool").at(-1);
    const name = lastTool ? "TaskOutput" : "Agent";
    const id = lastTool?.content.match(/agentId: (agent_[^\s]+)/)?.[1];
    if (!lastTool || id) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: name,
              type: "function",
              function: {
                name,
                arguments: JSON.stringify(
                  id
                    ? { task_id: id, block: true, timeout: 30000 }
                    : { description: "Read entry", prompt: "Read entry", run_in_background: true },
                ),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Collected task output" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.evaluate(() => window.zpi.setCapabilityEnabled("subagents", true));
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("Research and collect");
    await editor.press("Enter");
    const output = page.locator('main [data-tool-name="TaskOutput"]');
    await expect(output).toContainText("正在读取输出");
    await expect.poll(() => !!childResponse).toBe(true);
    send(
      childResponse as import("node:http").ServerResponse,
      chunk({ content: "Entry point is src/main.ts" }),
    );
    done(childResponse as import("node:http").ServerResponse);
    await expect(page.locator("main .answer")).toContainText("Collected task output");
    await expect(page.locator("main .answer")).toHaveCount(1);
    await page.locator("main").getByTestId("progress").first().click();
    await expect(output).toContainText("已读取");
    await output.getByTestId("tool-summary").click();
    await expect(output).toContainText("Entry point is src/main.ts");
    await expect(output).not.toContainText("retrieval_status");
    await expect(page.locator("main .user-message")).toHaveCount(1);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("message tools match ZCode summaries and keep coordinator inbox bodies out of visible user bubbles", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-subagents-messages-"));
  const server = await fakeServer((body, response) => {
    const names = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    const rows = body.messages as { role: string; content: string }[];
    const invoke = (name: string, id: string, params: unknown) => {
      send(
        response,
        chunk({
          tool_calls: [
            { index: 0, id, type: "function", function: { name, arguments: JSON.stringify(params) } },
          ],
        }),
      );
      done(response, "tool_calls");
    };
    if (!names.includes("Agent")) {
      if (!rows.some((row) => row.role === "tool"))
        invoke("RespondToCoordinator", "child-reply", {
          summary: "Located source",
          message: "PRIVATE COORDINATOR INBOX BODY",
        });
      else {
        send(
          response,
          chunk({
            content: rows.some((row) => row.content?.includes("REVISED REQUEST"))
              ? "Revised findings"
              : "Initial findings",
          }),
        );
        done(response);
      }
      return;
    }
    const lastTool = rows.filter((row) => row.role === "tool").at(-1);
    if (!lastTool)
      invoke("Agent", "research", { description: "Stable research title", prompt: "Initial task" });
    else if (lastTool.content.includes("use SendMessage to continue this agent"))
      invoke("SendMessage", "guidance", {
        to: /agentId: (agent_[a-z0-9-]+)/.exec(lastTool.content)?.[1],
        summary: "Revise scope",
        message: "REVISED REQUEST",
      });
    else {
      send(response, chunk({ content: "Coordinator report" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.evaluate(() => window.zpi.setCapabilityEnabled("subagents", true));
    await page.getByLabel("消息", { exact: true }).fill("Research and revise");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.locator("main .answer").first()).toContainText("Coordinator report");
    await expect(page.locator("main .user-message")).toHaveCount(1);
    await expect(page.locator("main")).not.toContainText("PRIVATE COORDINATOR INBOX BODY");
    await page.locator("main").getByTestId("progress").first().click();
    await page.getByRole("button", { name: "在侧栏查看 Stable research title", exact: true }).click();
    await expect(page.locator(".subagent-pane")).toContainText("Initial findings");
    await page.locator(".subagent-pane").getByTestId("progress").first().click();
    const reply = page.locator('.subagent-pane [data-tool-name="RespondToCoordinator"]');
    await expect(reply).toContainText("Located source");
    await expect(reply).toContainText("回复已排队");
    await expect(reply.locator("[aria-expanded]")).toHaveCount(0);
    await expect(reply).not.toContainText("PRIVATE COORDINATOR INBOX BODY");
    await expect(reply).not.toContainText("responseId");
    const guidance = page.locator('main [data-tool-name="SendMessage"]');
    await expect(guidance).toContainText("Revise scope");
    await guidance.getByRole("button", { name: "展开工具详情" }).click();
    await expect(guidance).toContainText("目标");
    await expect(guidance).toContainText("REVISED REQUEST");
    await expect(guidance).not.toContainText("messageId");
    await expect(page.getByRole("tab", { name: "Stable research title", exact: true })).toBeVisible();
    await expect(page.locator(".subagent-pane")).toContainText("Revised findings");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
