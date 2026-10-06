import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("streaming tools, manual expansion, default collapse, IME, safe renderer and restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "README.md"), "# Test project");
  const release = deferred();
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const results = messages.filter((m) => m.role === "tool");
    const user = messages.find((m) => m.role === "user")?.content;
    const calls = [
      { name: "read", arguments: { path: "README.md" } },
      { name: "write", arguments: { path: "demo.txt", content: "hello\n" } },
      { name: "edit", arguments: { path: "demo.txt", edits: [{ oldText: "hello", newText: "ZPI" }] } },
      { name: "bash", arguments: { command: "cat demo.txt" } },
    ];
    if (user === "完整工具演示" && results.length < 4) {
      const t = calls[results.length];
      send(response, chunk({ reasoning_content: `正在执行 ${t.name}\n` }));
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `t${results.length}`,
              type: "function",
              function: { name: t.name, arguments: JSON.stringify(t.arguments) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "首段已到达" }));
      if (user === "完整工具演示") await release.promise;
      send(response, chunk({ content: "\n\n**最终回复**：验证成功。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("完整工具演示");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.locator(".answer")).toContainText("首段已到达");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    if ((await page.getByTestId("progress").getAttribute("aria-expanded")) !== "true")
      await page.getByTestId("progress").click();
    await expect(page.getByTestId("process")).toContainText("README.md");
    await expect(page.getByTestId("process")).toContainText("cat demo.txt");
    await expect(page.locator('[data-tool-name="read"] .lucide-search')).toHaveCount(1);
    await expect(page.locator('[data-tool-name="write"] .lucide-pencil')).toHaveCount(1);
    await expect(page.locator('[data-tool-name="edit"] .lucide-pencil')).toHaveCount(1);
    await expect(page.locator('[data-tool-name="bash"] .lucide-square-terminal')).toHaveCount(1);
    await expect(page.locator(".process .status-dot")).toHaveCount(0);
    await page.screenshot({ path: "test-results/desktop-streaming.png" });
    release.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("progress")).toHaveAttribute("aria-expanded", "false");
    await page.getByTestId("progress").click();
    await expect(page.getByTestId("progress")).toHaveAttribute("aria-expanded", "true");
    await expect(page.locator(".answer")).toContainText("最终回复");
    expect(await readFile(join(project, "demo.txt"), "utf8")).toBe("ZPI\n");
    await page.getByLabel("消息", { exact: true }).fill("第二轮");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("progress").last()).toHaveAttribute("aria-expanded", "false");
    const before = server.requests.length;
    await page.getByLabel("消息", { exact: true }).fill("中文输入法");
    await page.getByLabel("消息", { exact: true }).dispatchEvent("compositionstart");
    await page
      .getByLabel("消息", { exact: true })
      .dispatchEvent("keydown", { key: "Enter", keyCode: 229, isComposing: true });
    await expect(page.getByTestId("run")).toHaveCount(2);
    expect(server.requests).toHaveLength(before);
    await page.getByLabel("消息", { exact: true }).dispatchEvent("compositionend");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(3);
    expect(
      await page.evaluate(() => ({
        node: typeof (window as unknown as { require?: unknown }).require,
        key: window.ZPI.getSettings().then((r) => JSON.stringify(r)),
      })),
    ).toMatchObject({ node: "undefined" });
    const settings = await page.evaluate(() => window.ZPI.getSettings());
    expect(JSON.stringify(settings)).not.toContain("local-test-key");
    expect(errors).toEqual([]);
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(3);
    await expect(page.getByTestId("progress").first()).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator(".answer").first()).toContainText("最终回复");
    await page.screenshot({ path: "test-results/desktop-history.png" });
  } finally {
    release.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
