import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { clipboardText, select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

test("at mentions search files and all enabled bots, insert canonical chips and preserve editing and submission", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-subagent-mentions-"));
  const project = join(dir, "project");
  const agents = join(project, ".zpi", "agents");
  await mkdir(agents, { recursive: true });
  for (const [name, description] of [
    ["zebra-review", "检查代码质量"],
    ["browser-audit", "浏览器操作"],
    ["qa-check", "验证测试结果"],
  ])
    await writeFile(
      join(agents, `${name}.md`),
      `---\nname: ${name}\ndescription: ${description}\n---\nHelp with the requested task.`,
    );
  await writeFile(join(project, "zebra-review.ts"), "export const value = 1;");
  const id = seedHistory(dir, project, 1).id;
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "received" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    await select(page, id);
    let editor = page.getByLabel("消息", { exact: true });
    let panel = page.getByRole("listbox", { name: "引用上下文", exact: true });
    await editor.fill("@");
    await expect(panel.locator(".subagent-option")).toHaveCount(5);
    await expect(panel.getByRole("option", { name: "zebra-review.ts", exact: true })).toBeVisible();
    await expect(panel.locator(".command-section-title")).toHaveText(["文件", "子智能体"]);
    await expect(panel.getByRole("option", { name: /^Explore/ })).toBeVisible();
    await expect(panel.getByRole("option", { name: /^qa-check 验证/ })).toBeVisible();
    await editor.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(editor).toHaveText("@");
    await editor.fill("@浏览器");
    await expect(panel.getByRole("option")).toHaveCount(1);
    await expect(panel.getByRole("option")).toContainText("browser-audit");
    await editor.fill("@浏器");
    await expect(panel.getByRole("option")).toHaveCount(0);
    await editor.fill("@ExP");
    await expect(panel.getByRole("option", { name: /^Explore/ })).toBeVisible();
    await editor.press("Enter");
    await expect(editor.locator(".inline-mention.subagent")).toHaveAttribute("data-markdown", "@Explore");
    expect(server.requests).toHaveLength(0);
    const primary = process.platform === "darwin" ? "Meta" : "Control";
    await editor.press(`${primary}+z`);
    await expect(editor).toHaveText("@ExP");
    await editor.press(`${primary}+Shift+z`);
    await expect(editor.locator(".inline-mention.subagent")).toHaveText("Explore");
    await editor.fill("@zbra-review rest");
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Node, 2);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await editor.pressSequentially("e");
    await panel.getByRole("option", { name: /^zebra-review 检查/ }).click();
    await expect(editor).toHaveText("zebra-review  rest");
    await editor.fill("前 尾");
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Node, 2);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await editor.pressSequentially("@zebra");
    await expect(panel.locator(".subagent-option")).toHaveCount(1);
    await expect(panel.getByRole("option", { name: "zebra-review.ts", exact: true })).toBeVisible();
    await expect(panel.getByRole("status")).toHaveCount(0);
    await editor.press("ArrowUp");
    await expect(panel.getByRole("option", { name: /^zebra-review 检查/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await page.screenshot({
        path: `test-results/subagent-mentions-${colorScheme}.png`,
        animations: "disabled",
      });
    }
    await editor.press("Tab");
    await expect(editor).toHaveText("前 zebra-review 尾");
    await page.keyboard.type("X");
    await expect(editor).toHaveText("前 zebra-review X尾");
    await editor.press(`${primary}+a`);
    expect(await clipboardText(page)).toBe("前 @zebra-review X尾");
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    editor = page.getByLabel("消息", { exact: true });
    panel = page.getByRole("listbox", { name: "引用上下文", exact: true });
    await expect(editor.locator(".inline-mention.subagent")).toHaveText("zebra-review");
    await editor.press("ArrowRight");
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(1);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".user-message-text .inline-mention.subagent").last()).toHaveText(
      "zebra-review",
    );
    expect(server.requests[0].messages).toContainEqual(
      expect.objectContaining({ role: "user", content: "前 @zebra-review X尾" }),
    );
    await editor.fill("@zebra");
    await panel.getByRole("option", { name: /^zebra-review 检查/ }).click();
    await expect(editor).toBeFocused();
    await expect(editor.locator(".inline-mention.subagent")).toHaveAttribute(
      "data-markdown",
      "@zebra-review",
    );
    await expect(editor.locator(".inline-mention.file")).toHaveCount(0);
    await rm(join(agents, "zebra-review.md"));
    await writeFile(
      join(agents, "late-review.md"),
      "---\nname: late-review\ndescription: 最新配置\n---\nUse the latest role.",
    );
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await editor.fill("@late-review");
    await expect(panel.getByRole("option", { name: /^late-review 最新配置/ })).toBeVisible();
    await editor.press("Tab");
    await expect(editor.locator(".inline-mention.subagent")).toHaveAttribute("data-markdown", "@late-review");
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[1].messages)).toContain('subagent_type \\"late-review\\"');
    await editor.fill("@zebra-review");
    await expect(panel.locator(".subagent-option")).toHaveCount(0);
    await rm(join(agents, "late-review.md"));
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await editor.fill("@late-review");
    await expect(panel.getByRole("option", { name: /^late-review/ })).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
