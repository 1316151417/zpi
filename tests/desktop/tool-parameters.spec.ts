import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("write Parameters follow ZCode's empty input, partial input, content and result stages", async () => {
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
              function: { arguments: '"path":"streamed.ts","content":"' },
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
              function: { arguments: JSON.stringify(source).slice(1, -1) },
            },
          ],
        }),
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
    await expect(write.locator(".tool-parameters h4")).toHaveText("Parameters");
    await expect(write.locator(".tool-parameters h4")).toHaveCSS("font-size", "14px");
    await expect(write.locator(".tool-parameters h4")).toHaveCSS("text-transform", "uppercase");
    await expect(write.locator(".tool-parameters-code")).toHaveCSS("max-height", "240px");
    await expect(write.locator(".tool-input-code pre")).toHaveCSS("font-size", "14px");
    await expect(write.locator(".tool-input-code")).toContainText('"path": "streamed.ts"');
    await expect(write.locator(".tool-content-fade")).toHaveCSS("opacity", "1");
    await page.screenshot({ path: "test-results/tool-parameters-partial.png" });

    await write.locator(".tool-file-chip").click();
    const pendingPreview = page.locator(".pending-file-preview");
    await expect(pendingPreview).toContainText('"path": "streamed.ts"');
    await expect(page.locator(".error-toast")).toHaveCount(0);

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
    await expect(page.locator(".error-toast")).toHaveCount(0);
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
