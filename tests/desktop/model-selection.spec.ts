import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("running Zhipu selection switches to DeepSeek for an immediate queued message and safe retry", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-switch-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "switch fixture");
  const waiting = deferred();
  const violations: unknown[] = [];
  let deepseekCalls = 0;
  const server = await fakeServer((body, response) => {
    const rows = body.messages as unknown as {
      role: string;
      content: string | null;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
    }[];
    if (body.model === "glm-fixture") {
      if (!rows.some((row) => row.role === "tool")) {
        send(response, chunk({ reasoning_content: "查看文件" }));
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "read-switch",
                type: "function",
                function: { name: "read", arguments: '{"path":"README.md"}' },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      } else {
        response.write(": waiting\n\n");
        waiting.resolve();
      }
      return;
    }
    for (const row of rows)
      if (row.role === "assistant" && !row.content && !row.tool_calls?.length) violations.push(row);
    deepseekCalls++;
    if (rows.findLast((row) => row.role === "user")?.content === "切换后继续") {
      // A provider stream error leaves a durable empty assistant record; retry must exclude it too.
      done(response, "content_filter");
    } else {
      send(response, chunk({ content: "切换成功，历史继续" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.evaluate(async (url) => {
      for (const [id, name, modelId] of [
        ["switch-zhipu", "智谱测试", "glm-fixture"],
        ["switch-deepseek", "DeepSeek测试", "deepseek-fixture"],
      ]) {
        const result = await window.ZPI.saveProvider({
          id,
          name,
          baseUrl: url,
          apiKey: "isolated-key",
          models: [
            {
              id: modelId,
              name: modelId,
              input: ["text"],
              reasoning: true,
              contextWindow: 32768,
              maxTokens: 4096,
              compat: { supportsReasoningEffort: true, requiresReasoningContentOnAssistantMessages: true },
            },
          ],
        });
        if (!result.ok) throw new Error(result.error.message);
      }
    }, server.url);
    await page.reload();
    const choose = async (model: string) => {
      await page.getByLabel("模型选择", { exact: true }).click();
      await page.getByRole("menuitem", { name: model, exact: true }).hover();
      await page.getByRole("menuitem", { name: "关闭", exact: true }).click();
      await expect(page.getByLabel("模型选择", { exact: true })).toContainText(model);
    };
    await choose("glm-fixture");
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("查看文件");
    await editor.press("Enter");
    await waiting.promise;
    await choose("deepseek-fixture");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    expect(deepseekCalls).toBe(0);
    await editor.fill("切换后继续");
    await editor.press("Enter");
    await expect(page.getByTestId("queue-item")).toHaveCount(1);
    expect(deepseekCalls).toBe(0);
    await page.getByRole("button", { name: "立即", exact: true }).click();
    await expect(page.getByTestId("run").first()).toHaveAttribute("data-status", "aborted");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "error");
    expect(deepseekCalls).toBe(1);
    await page.reload();
    await expect(page.getByTestId("run")).toHaveCount(2);
    await editor.fill("再次继续");
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".answer").last()).toContainText("切换成功，历史继续");
    expect(violations).toEqual([]);
    expect(deepseekCalls).toBe(2);
    const last = server.requests.at(-1)?.messages as unknown as {
      role: string;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
      content: string;
    }[];
    expect(last.find((row) => row.role === "assistant")?.tool_calls?.[0].id).toBe("read-switch");
    expect(last.find((row) => row.role === "tool")?.tool_call_id).toBe("read-switch");
    expect(last.filter((row) => row.role === "user").map((row) => row.content)).toEqual([
      "查看文件",
      "切换后继续",
      "再次继续",
    ]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
