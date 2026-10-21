import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("expanding a streaming Markdown write keeps the conversation footer near the composer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-write-layout-"));
  const project = join(dir, "project");
  await mkdir(project);
  const content = deferred();
  const complete = deferred();
  const finish = deferred();
  const source = [
    "| 指标 | 名称 | 原表单元数 | 已生成未结算回算单元 | 当前无对应明细单元 |",
    "| --- | --- | --- | --- | --- |",
    ...Array.from({ length: 100 }, (_, i) => `| ${i} | 平台支付业主违约金成本 | 11 | 0 | 11 |`),
    "",
    "## 汇总",
    "",
    "| 状态 | 数量 |",
    "| --- | --- |",
    "| 待补算 | 100 |",
  ].join("\n");
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(response, chunk({ content: "复核发现，需要生成排查说明。\n\n".repeat(50) }));
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write-report",
              type: "function",
              function: {
                name: "write",
                arguments: '{"path":"report.md","content":"',
              },
            },
          ],
        }),
      );
      await content.promise;
      send(
        response,
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(source).slice(1, -1) } }] }),
      );
      await complete.promise;
      send(response, chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));
      done(response, "tool_calls");
    } else {
      await finish.promise;
      send(response, chunk({ content: "完成。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("生成排查说明");
    await page.getByLabel("发送", { exact: true }).click();
    const write = page.locator('[data-tool-name="write"]');
    const summary = write.getByTestId("tool-summary");
    await expect(summary).toContainText("report.md");
    await summary.locator(".tool-kind-label").click();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    content.resolve();
    await expect(write.locator(".tool-markdown-preview")).toContainText("平台支付业主违约金成本");
    await expect(write.locator(".tool-content-fade")).toHaveCSS("opacity", "1");
    await summary.locator(".tool-kind-label").click();
    await expect(write.locator(".tool-content-shell")).toBeHidden();
    await summary.locator(".tool-kind-label").click();
    await expect(write.locator(".tool-content-fade")).toHaveCSS("opacity", "1");
    await expect
      .poll(() =>
        page.locator(".conversation").evaluate((el) => {
          const content = el.querySelector(".conversation-inner");
          if (!content) throw new Error("Missing conversation content");
          return el.scrollHeight - Math.max(el.clientHeight, content.getBoundingClientRect().height);
        }),
      )
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const loading = document.querySelector(".chat-loading-slot");
          const composer = document.querySelector(".composer-container > .composer-stack > .composer");
          if (!loading || !composer) throw new Error("Missing loading slot or composer");
          return composer.getBoundingClientRect().top - loading.getBoundingClientRect().bottom;
        }),
      )
      .toBe(20);
    await page.screenshot({ path: "test-results/write-markdown-expanded.png" });
    complete.resolve();
    await expect.poll(() => server.requests.length).toBe(2);
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
  } finally {
    for (const gate of [content, complete, finish]) gate.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("streaming Markdown previews wrap prose and inline code while wide blocks scroll locally", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-stream-preview-width-"));
  const project = join(dir, "project");
  await mkdir(project);
  const complete = deferred();
  const token = "LongUnbrokenIdentifier".repeat(12);
  const source = [
    "# 文件预览换行",
    "",
    `普通正文：${token}。`,
    "",
    `行内路径：\`/backdoor/${token}/refresh\`。`,
    "",
    `|${Array.from({ length: 12 }, (_, i) => ` 列 ${i} `).join("|")}|`,
    `|${Array.from({ length: 12 }, () => " --- ").join("|")}|`,
    `|${Array.from({ length: 12 }, () => " 待确认 ").join("|")}|`,
    "",
    "```text",
    token,
    "```",
  ].join("\n");
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write-preview",
              type: "function",
              function: {
                name: "write",
                arguments: `{"path":"report.md","content":${JSON.stringify(source).slice(0, -1)}`,
              },
            },
          ],
        }),
      );
      await complete.promise;
      send(response, chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "[report.md](report.md)" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 760));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("生成预览");
    await page.getByLabel("发送", { exact: true }).click();
    await page.locator('[data-tool-name="write"] .tool-file-chip').click();
    const pending = page.locator(".pending-file-preview");
    await expect(pending).toContainText("文件预览换行");
    await expect(page.locator(".right-pane")).not.toHaveAttribute("data-animating", "true");
    for (const viewport of [
      pending,
      pending.locator(".markdown-body"),
      page.locator(".file-manager:visible .file-manager-preview"),
    ]) {
      await expect
        .poll(() => viewport.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeLessThanOrEqual(1);
    }
    for (const selector of [".markdown-table-scroll", ".markdown-code-body pre"]) {
      const block = pending.locator(selector);
      await expect
        .poll(() => block.evaluate((element) => element.scrollWidth - element.clientWidth))
        .toBeGreaterThan(100);
      expect(
        await block.evaluate((element) => {
          element.scrollLeft = 100;
          return element.scrollLeft;
        }),
      ).toBeGreaterThan(0);
      expect(await pending.evaluate((element) => element.scrollLeft)).toBe(0);
    }
    complete.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await page.locator(".answer").getByRole("button", { name: "report.md", exact: true }).click();
    const finished = page.locator(".file-markdown-preview");
    await expect(finished).toContainText("文件预览换行");
    await expect
      .poll(() => finished.evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBeLessThanOrEqual(1);
  } finally {
    complete.resolve();
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ]);
  }
});

test("streaming edit previews use the pane height instead of a nested 240-pixel card", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-edit-preview-height-"));
  const project = join(dir, "project");
  await mkdir(project);
  const oldText = Array.from({ length: 80 }, (_, i) => `原文第 ${i + 1} 行：等待审查。`).join("\n");
  const newText = oldText.replace("等待审查", "已经修订");
  await writeFile(join(project, "report.md"), oldText);
  const replacement = deferred();
  const complete = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "edit-preview",
              type: "function",
              function: {
                name: "edit",
                arguments: `{"path":"report.md","oldText":${JSON.stringify(oldText)},"newText":"`,
              },
            },
          ],
        }),
      );
      await replacement.promise;
      send(
        response,
        chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(newText).slice(1, -1) } }] }),
      );
      await complete.promise;
      send(response, chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "已修订。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(920, 760));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("修订文件");
    await page.getByLabel("发送", { exact: true }).click();
    const edit = page.locator('[data-tool-name="edit"]');
    await edit.locator(".tool-file-chip").click();
    const pending = page.locator(".pending-file-preview");
    const diff = pending.locator(".tool-inline-diff");
    await expect(diff).toContainText("原文第 80 行");
    await expect.poll(() => diff.evaluate((element) => element.clientHeight)).toBeGreaterThan(240);
    await expect
      .poll(() => diff.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeLessThanOrEqual(1);
    await expect
      .poll(() => pending.evaluate((element) => element.scrollHeight - element.clientHeight))
      .toBeGreaterThan(100);
    expect(
      await pending.evaluate((element) => {
        element.scrollTop = 400;
        return element.scrollTop;
      }),
    ).toBeGreaterThan(0);
    replacement.resolve();
    await expect(diff.locator(".added").first()).toContainText("已经修订");
    await expect(diff).toHaveCSS("max-height", "none");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1600, 1000));
    await edit.getByTestId("tool-summary").locator(".tool-kind-label").click();
    await expect(edit.locator(".tool-inline-diff")).toHaveCSS("max-height", "240px");
    complete.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(pending).toHaveCount(0);
    await expect(page.locator(".changes-pane [data-diff-id]")).toHaveCount(1);
  } finally {
    replacement.resolve();
    complete.resolve();
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
    ]);
  }
});

test("write previews hide partial parameters and show streamed content and the final diff", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-tool-parameters-"));
  const project = join(dir, "project");
  await mkdir(project);
  const path = deferred();
  const content = deferred();
  const complete = deferred();
  const finish = deferred();
  const source = 'export const value = "中文";\n';
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "streamed-write",
              type: "function",
              function: { name: "write", arguments: "{" },
            },
          ],
        }),
      );
      await path.promise;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: '"path":"streamed.ts"' },
            },
          ],
        }),
      );
      await content.promise;
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              function: { arguments: `,"content":${JSON.stringify(source)}` },
            },
          ],
        }),
      );
      await complete.promise;
      send(response, chunk({ tool_calls: [{ index: 0, function: { arguments: "}" } }] }));
      done(response, "tool_calls");
    } else {
      await finish.promise;
      send(response, chunk({ content: "完成。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("验证流式参数展示");
    await page.getByLabel("发送", { exact: true }).click();
    const write = page.locator('[data-tool-name="write"]');
    const summary = write.getByTestId("tool-summary");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await summary.click();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect(write.locator(".tool-file-details")).toHaveCount(1);
    await expect(write.locator(".tool-parameters")).toHaveCount(0);
    await expect(write.locator(".tool-content-preview")).toHaveCount(0);

    path.resolve();
    await expect(write.locator(".tool-file-chip")).toContainText("streamed.ts");
    await expect(write.locator(".tool-parameters")).toHaveCount(0);
    await expect(write.locator(".tool-content-preview")).toHaveCount(0);
    await expect(write.locator(".tool-content-fade")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/tool-parameters-partial.png" });

    await write.locator(".tool-file-chip").click();
    const pendingPreview = page.locator(".pending-file-preview");
    await expect(pendingPreview).toContainText("正在生成文件内容");
    await expect(pendingPreview.locator(".tool-parameters")).toHaveCount(0);
    await expect(page.locator(".notice-window")).toHaveCount(0);

    content.resolve();
    const preview = write.locator(".tool-content-preview");
    await expect(preview).toContainText(source.trim());
    await expect(preview).toBeVisible();
    await expect(pendingPreview).toContainText(source.trim());
    await page.getByLabel("关闭标签 streamed.ts", { exact: true }).click();
    await expect(preview.locator(".tool-input-code")).toHaveAttribute("data-language", "typescript");
    await expect(preview).toHaveCSS("max-height", "240px");
    await expect(write.locator(".tool-parameters")).toHaveCount(0);
    // A display preview is not a prematurely executed write.
    await expect(readFile(join(project, "streamed.ts"))).rejects.toThrow();
    await page.screenshot({ path: "test-results/tool-parameters-content.png" });
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "dark";
    });
    await page.screenshot({ path: "test-results/tool-parameters-content-dark.png" });
    await summary.locator(".tool-kind-label").click();
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await summary.locator(".tool-kind-label").click();
    await expect(preview).toContainText(source.trim());
    await expect(write.locator(".tool-parameters")).toHaveCount(0);

    await write.locator(".tool-file-chip").click();
    await expect(pendingPreview).toBeVisible();
    complete.resolve();
    await expect.poll(() => server.requests.length).toBe(2);
    await expect(write.locator(".tool-inline-diff")).toContainText(source.trim());
    await expect(write.locator(".tool-content-preview")).toHaveCount(0);
    await expect(write.locator(".tool-parameters")).toHaveCount(0);
    await expect(pendingPreview).toHaveCount(0);
    await expect(page.locator(".changes-pane [data-diff-id]")).toHaveCount(1);
    await expect(page.locator(".notice-window")).toHaveCount(0);
    expect(await readFile(join(project, "streamed.ts"), "utf8")).toBe(source);
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
  } finally {
    for (const gate of [path, content, complete, finish]) gate.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
