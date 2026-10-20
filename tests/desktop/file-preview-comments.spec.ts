import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

async function selectLines(page: Page, start: number, end = start) {
  const preview = page.getByRole("region", { name: "文件预览", exact: true });
  const first = preview.locator(`[data-column-number="${start}"]`).first();
  if (start === end) {
    await first.click();
  } else {
    const last = preview.locator(`[data-column-number="${end}"]`).first();
    const from = await first.boundingBox();
    const to = await last.boundingBox();
    if (!from || !to) throw new Error("Missing file gutter coordinates");
    await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
    await page.mouse.down();
    await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 5 });
    await page.mouse.up();
  }
  await expect(preview.locator("[data-file-comment-draft]")).toBeVisible();
  return preview;
}

for (const target of ["main", "side"] as const) {
  test(`file comments preserve ${target} draft ownership, cancellation, deletion and composer removal`, async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-file-comments-")));
    const project = join(dir, "project");
    await mkdir(project);
    const path = join(project, "example.ts");
    await writeFile(path, "const first = 1;\nconst second = 2;\nconst third = 3;\n");
    const requests: string[] = [];
    const server = await fakeServer((body, response) => {
      requests.push(JSON.stringify(body));
      send(response, chunk({ content: `[示例文件](<${path}>)` }));
      done(response);
    });
    let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
    try {
      app = await launchDesktop({ dir, url: server.url, project });
      const page = await app.firstWindow();
      const main = page.locator("main");
      await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
      await main.getByLabel("消息", { exact: true }).fill("显示文件");
      await main.getByLabel("发送", { exact: true }).click();
      await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
      await main.getByLabel("消息", { exact: true }).fill("保留主草稿");
      if (target === "side") {
        await page.getByLabel("展开右侧栏", { exact: true }).click();
        await page
          .locator(".pane-empty-launcher")
          .getByRole("button", { name: "辅助对话", exact: true })
          .click();
        const side = page.getByRole("region", { name: "辅助对话", exact: true });
        await side.getByLabel("消息", { exact: true }).fill("显示辅助文件");
        await side.getByLabel("发送", { exact: true }).click();
        await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
        await side.getByLabel("消息", { exact: true }).fill("保留辅助草稿");
      }
      const owner = target === "main" ? main : page.getByRole("region", { name: "辅助对话", exact: true });
      await owner.locator(".answer").last().getByRole("button", { name: "示例文件", exact: true }).click();
      const preview = await selectLines(page, 1);
      await preview.getByLabel("代码备注", { exact: true }).fill("应取消的备注");
      await preview.getByLabel("代码备注", { exact: true }).press("Escape");
      await expect(preview.locator("[data-file-comment-draft]")).toHaveCount(0);
      await expect(preview.locator("[data-file-comment-id]")).toHaveCount(0);
      await expect(preview.locator("[data-selected-line]")).toHaveCount(0);
      await selectLines(page, 2, 3);
      await preview.getByLabel("代码备注", { exact: true }).fill("检查多行上下文");
      await preview.getByRole("button", { name: /添加到对话/ }).click();
      await expect(preview.locator("[data-file-comment-id]")).toContainText("检查多行上下文");
      await expect(preview.locator("[data-file-comment-id]")).toContainText("评论第 2 行到第 3 行");
      await expect(preview.locator("[data-selected-line]")).toHaveCount(0);
      if (target === "side")
        await expect(main.locator(".composer-container .selection-reference-chip")).toHaveCount(0);
      await preview.getByRole("button", { name: "删除评论", exact: true }).click();
      await expect(preview.locator("[data-file-comment-id]")).toHaveCount(0);
      await expect(preview.locator("[data-selected-line]")).toHaveCount(0);
      await selectLines(page, 1);
      await preview.getByRole("button", { name: /添加到对话/ }).click();
      await expect(preview.locator("[data-file-comment-id]")).toHaveCount(1);
      if (target === "side")
        await page.getByRole("tab", { name: "辅助对话 1", exact: true }).locator(".pane-tab-trigger").click();
      await owner
        .locator(".composer-container")
        .getByRole("button", { name: "移除全部评论", exact: true })
        .click();
      await expect(owner.locator(".composer-container .selection-reference-chip")).toHaveCount(0);
      await page.getByRole("tab", { name: "example.ts", exact: true }).locator(".pane-tab-trigger").click();
      await expect(preview.locator("[data-file-comment-id]")).toHaveCount(0);
      await expect(preview.locator("[data-selected-line]")).toHaveCount(0);
      await selectLines(page, 2, 3);
      await preview.getByLabel("代码备注", { exact: true }).fill("最终提交备注");
      await preview.getByRole("button", { name: /添加到对话/ }).click();
      if (target === "side")
        await page.getByRole("tab", { name: "辅助对话 1", exact: true }).locator(".pane-tab-trigger").click();
      const commentPill = owner
        .locator(".composer-container")
        .getByRole("button", { name: "1 条评论", exact: true });
      await owner.getByLabel("消息", { exact: true }).focus();
      await commentPill.hover();
      await expect(owner.getByLabel("消息", { exact: true })).toBeFocused();
      const commentDetails = page.getByRole("dialog", { name: "评论内容", exact: true });
      await expect(commentDetails).toContainText("example.ts");
      await expect(commentDetails).toContainText("L2-L3");
      await expect(commentDetails).toContainText("最终提交备注");
      await expect(commentDetails).not.toContainText("const second = 2;");
      await expect(commentDetails.locator("small")).toHaveCSS("text-overflow", "ellipsis");
      await commentPill.focus();
      await commentPill.press("Enter");
      await expect(
        commentDetails.getByRole("button", { name: "打开 example.ts L2-L3", exact: true }),
      ).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(commentDetails.getByRole("button", { name: "移除评论", exact: true })).toBeFocused();
      await page.keyboard.press("Escape");
      await expect(commentPill).toBeFocused();
      await expect(commentDetails).toHaveCount(0);
      // Escape closes the card while the pointer remains over the trigger.
      // Re-enter it to exercise the next hover, rather than hovering the same coordinates.
      await page.mouse.move(0, 0);
      await commentPill.hover();
      await commentDetails.getByRole("button", { name: "打开 example.ts L2-L3", exact: true }).click();
      await expect(preview).toBeVisible();
      if (target === "side")
        await page.getByRole("tab", { name: "辅助对话 1", exact: true }).locator(".pane-tab-trigger").click();
      await expect(owner.getByLabel("消息", { exact: true })).toHaveText(
        target === "main" ? "保留主草稿" : "保留辅助草稿",
      );
      await owner.getByLabel("发送", { exact: true }).click();
      await expect.poll(() => requests.at(-1)).toContain("最终提交备注");
      expect(requests.at(-1)).toContain("const second = 2;");
      expect(requests.at(-1)).toContain("const third = 3;");
      const sentComment = owner
        .getByTestId("run")
        .last()
        .getByRole("button", { name: "1 条评论", exact: true });
      await expect(sentComment).toBeVisible();
      await sentComment.hover();
      await expect(commentDetails).toContainText("最终提交备注");
      await expect(commentDetails.getByRole("button", { name: "移除评论", exact: true })).toHaveCount(0);
      if (target === "side") await expect(main.getByLabel("消息", { exact: true })).toHaveText("保留主草稿");
    } finally {
      await runCleanup([
        () => app?.close(),
        () => server.close(),
        () => rm(dir, { recursive: true, force: true }),
      ]);
    }
  });
}

test("text preview menu reflects wrap state, copies exact paths and dismisses on Escape", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-file-preview-menu-")));
  const project = join(dir, "project");
  await mkdir(project);
  const path = join(project, "long.ts");
  await writeFile(path, `const message = "${"long line ".repeat(80)}";\n`);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[长文件](<${path}>)` }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("显示文件");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await page.locator(".answer").getByRole("button", { name: "长文件", exact: true }).click();
    const preview = page.getByRole("region", { name: "文件预览", exact: true });
    const trigger = preview.getByRole("button", { name: "文件预览菜单", exact: true });
    await trigger.click();
    const wrap = page.getByRole("menuitemcheckbox", { name: "自动换行", exact: true });
    await expect(wrap).toHaveAttribute("aria-checked", "false");
    await wrap.click();
    await trigger.click();
    await expect(wrap).toHaveAttribute("aria-checked", "true");
    await page.getByRole("menuitem", { name: "复制相对路径", exact: true }).click();
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toBe("long.ts");
    await trigger.click();
    await page.getByRole("menuitem", { name: "复制绝对路径", exact: true }).click();
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toBe(path);
    await trigger.click();
    await wrap.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(preview.getByRole("button", { name: "使用默认程序打开", exact: true })).toBeEnabled();
    await page.screenshot({ path: "test-results/file-preview-wrap-menu.png" });
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
