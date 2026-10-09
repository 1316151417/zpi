import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("automatic overflow compaction uses the same divider and stays visible after the work is collapsed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-auto-compaction-divider-"));
  await mkdir(join(dir, "agent"));
  await writeFile(join(dir, "agent/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 0 } }));
  const release = deferred();
  let recovered = false;
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    if (JSON.stringify(messages).includes("ONLY output the structured summary")) {
      await release.promise;
      send(response, chunk({ content: "Earlier work summary" }));
      recovered = true;
    } else if (
      !recovered &&
      messages.findLast((message) => message.role === "user")?.content === "overflow"
    ) {
      response.writeHead(400, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "maximum context length exceeded" } }));
      return;
    } else send(response, chunk({ content: "完整回复" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("first");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("消息", { exact: true }).fill("overflow");
    await page.getByLabel("发送", { exact: true }).click();
    const marker = page.getByTestId("compaction-divider");
    await expect(marker).toHaveAttribute("data-status", "running");
    await expect(marker).toHaveAttribute("data-origin", "auto");
    await expect(marker).toHaveText("正在压缩上下文");
    await expect(page.locator(".chat-loading-slot")).toHaveCount(0);
    release.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(marker).toHaveText("上下文已自动压缩");
    await expect(marker).toBeVisible();
    await expect(page.getByTestId("process")).toHaveCount(0);
    await page.reload();
    await expect(marker).toHaveText("上下文已自动压缩");
    await expect(page.locator(".user-message-text")).toHaveText(["first", "overflow"]);
  } finally {
    release.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const outcome of ["completed", "error", "aborted"] as const) {
  test(`manual compaction is a timeline divider, persists ${outcome} and preserves chat history`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ZPI-compaction-divider-"));
    await mkdir(join(dir, "agent"));
    await writeFile(
      join(dir, "agent/settings.json"),
      JSON.stringify({ compaction: { keepRecentTokens: 0 } }),
    );
    const release = deferred();
    const server = await fakeServer(async (body, response) => {
      const compacting = JSON.stringify(body.messages).includes("ONLY output the structured summary");
      if (compacting) {
        await release.promise;
        if (outcome === "error") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Synthetic summary failure" } }));
          return;
        }
        send(response, chunk({ content: "Earlier work summary" }));
      } else {
        send(response, chunk({ content: "完整回复" }));
        send(response, {
          ...chunk({}),
          choices: [],
          usage: { prompt_tokens: 2048, completion_tokens: 8, total_tokens: 2056 },
        });
      }
      done(response);
    });
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, url: server.url });
      const page = await app.firstWindow();
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(1200, 900));
      for (const [index, text] of ["first", "second"].entries()) {
        await page.getByLabel("消息", { exact: true }).fill(text);
        await page.getByLabel("发送", { exact: true }).click();
        await expect(page.getByTestId("run")).toHaveCount(index + 1);
        await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
      }
      await page.getByLabel("消息", { exact: true }).fill("/compact keep decisions");
      await page.getByLabel("发送", { exact: true }).click();
      const marker = page.getByTestId("compaction-divider");
      await expect(marker).toHaveAttribute("data-status", "running");
      await expect(marker).toHaveText("正在压缩上下文");
      await expect(marker.locator("svg")).toHaveCount(0);
      await expect(marker.locator(".thinking-label-streaming")).toBeVisible();
      await expect(page.getByTestId("run")).toHaveCount(2);
      await expect(page.locator(".user-message-text")).toHaveText(["first", "second"]);
      await expect(page.locator(".chat-loading-slot")).toHaveCount(0);
      await expect(page.getByLabel("消息", { exact: true })).toHaveAttribute(
        "data-placeholder",
        "继续输入以排队后续修改",
      );
      if (outcome === "completed") {
        await page.screenshot({ path: "test-results/compaction-running.png" });
        await page.getByLabel("消息", { exact: true }).fill("queued follow-up");
        await page.getByLabel("加入队列", { exact: true }).click();
        await expect(marker).toHaveAttribute("data-status", "running");
      }
      if (outcome === "aborted") await page.getByLabel("停止", { exact: true }).click();
      else release.resolve();
      await expect(marker).toHaveAttribute("data-status", outcome);
      await expect(marker).toHaveText(
        outcome === "completed"
          ? "上下文已压缩"
          : outcome === "error"
            ? "上下文压缩失败"
            : "上下文压缩已中断",
      );
      await expect(marker.locator("svg.lucide-archive")).toHaveCount(1);
      await expect(marker.locator(".thinking-label-streaming")).toHaveCount(0);
      if (outcome === "completed") {
        await expect(page.getByTestId("run")).toHaveCount(3);
        await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
        await expect(page.getByLabel("消息", { exact: true })).toHaveAttribute(
          "data-placeholder",
          "提出后续修改要求",
        );
        await page.screenshot({ path: "test-results/compaction-completed.png" });
      }
      await page.reload();
      await expect(marker).toHaveAttribute("data-status", outcome);
      await expect(page.locator(".user-message-text")).toHaveText(
        outcome === "completed" ? ["first", "second", "queued follow-up"] : ["first", "second"],
      );
      const summaryRequests = server.requests.filter((body) =>
        JSON.stringify(body.messages).includes("ONLY output the structured summary"),
      );
      expect(summaryRequests.length).toBeGreaterThan(0);
      if (outcome === "completed") {
        expect(summaryRequests).toHaveLength(2);
        const request = JSON.stringify(server.requests.at(-1)?.messages);
        expect(request).toContain("Earlier work summary");
        expect(request).not.toContain('"content":"first"');
        expect(request).not.toContain("/compact keep decisions");
      }
    } finally {
      release.resolve();
      await app?.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
