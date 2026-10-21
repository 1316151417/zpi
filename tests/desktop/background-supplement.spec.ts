import { mkdtemp, rm } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("keeps the main answer visible beside a separately titled late background supplement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-background-supplement-"));
  const answering = deferred();
  let childResponse: ServerResponse | undefined;
  let parentResponse: ServerResponse | undefined;
  const server = await fakeServer((body, response) => {
    const tools = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    const messages = body.messages as { role: string; content: string }[];
    if (!tools.includes("Agent")) {
      childResponse = response;
    } else if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "research",
              type: "function",
              function: {
                name: "Agent",
                arguments: JSON.stringify({
                  description: "核查查询 SQL",
                  prompt: "Inspect SQL",
                  run_in_background: true,
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else if (JSON.stringify(messages).includes("<task-notification>")) {
      send(response, chunk({ content: "补充：周期表缺少软删除过滤。" }));
      done(response);
    } else {
      parentResponse = response;
      send(response, chunk({ content: "主任务完整结论：需要结合请求日志确认原因。" }));
      answering.resolve();
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
    await editor.fill("Investigate the query");
    await editor.press("Enter");
    await answering.promise;
    await expect.poll(() => !!childResponse).toBe(true);
    send(childResponse as ServerResponse, chunk({ content: "Late SQL findings" }));
    done(childResponse as ServerResponse);
    await expect(page.getByRole("complementary", { name: "任务状态", exact: true })).toHaveAttribute(
      "data-running",
      "false",
    );
    done(parentResponse as ServerResponse);
    const runs = page.locator("main [data-testid=run]");
    await expect(runs).toHaveCount(2);
    await expect(runs.nth(0).locator(".answer")).toContainText("主任务完整结论");
    await expect(runs.nth(0).getByTestId("background-result-heading")).toHaveCount(0);
    await expect(runs.nth(1).getByTestId("background-result-heading")).toHaveText("核查查询 SQL");
    await expect(runs.nth(1).getByTestId("progress")).toHaveCount(0);
    await expect(runs.nth(0).getByTestId("progress")).toHaveCount(1);
    await expect(runs.nth(1).locator(".answer")).toContainText("补充：周期表缺少软删除过滤。");
    await expect(page.locator("main")).not.toContainText("<task-notification>");
    for (const theme of ["light", "dark"] as const) {
      await page.evaluate(async (theme) => {
        const result = await window.zpi.updatePreferences({ theme });
        if (!result.ok) throw new Error(result.error.message);
      }, theme);
      await page.reload();
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.locator("main .answer")).toHaveCount(2);
      await expect(page.getByTestId("background-result-heading")).toHaveText("核查查询 SQL");
      await expect(page.locator("main [data-testid=run]").nth(1).getByTestId("progress")).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath(`background-supplement-${theme}.png`),
        animations: "disabled",
      });
    }
  } finally {
    await runCleanup([() => app?.close(), server.close, () => rm(dir, { recursive: true, force: true })]);
  }
});
