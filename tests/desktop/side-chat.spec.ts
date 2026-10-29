import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPresentation } from "../../packages/ui/src/components/process-presentation.ts";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

for (const pane of ["main", "side"] as const) {
  test(`${pane} keeps the completed answer outside trailing reasoning in live and restored history`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-trailing-reasoning-"));
    const finish = deferred();
    const server = await fakeServer(async (_, response, index) => {
      if (pane === "side" && index === 0) {
        send(response, chunk({ content: "主对话已就绪" }));
      } else {
        send(response, chunk({ content: "已完成的查询结果" }));
        send(response, chunk({ reasoning_content: "Awaiting user input" }));
        await finish.promise;
      }
      done(response);
    });
    let app: Awaited<ReturnType<typeof launchDesktop>>;
    try {
      app = await launchDesktop({ dir, url: server.url });
      const page = await app.firstWindow();
      const main = page.locator("main");
      if (pane === "side") {
        await main.getByLabel("消息", { exact: true }).fill("主问题");
        await main.getByLabel("发送", { exact: true }).click();
        await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
        await page.getByLabel("展开右侧栏", { exact: true }).click();
        await page
          .locator(".pane-empty-launcher")
          .getByRole("button", { name: "辅助对话", exact: true })
          .click();
      }
      const target = pane === "main" ? main : page.getByRole("region", { name: "辅助对话", exact: true });
      await target.getByLabel("消息", { exact: true }).fill("查询结果");
      await target.getByLabel("发送", { exact: true }).click();
      const run = target.getByTestId("run").last();
      await expect(run).toHaveAttribute("data-status", "running");
      await expect(run.getByTestId("process")).toContainText("已完成的查询结果");
      await expect(run.getByTestId("thinking-block")).toContainText("Awaiting user input");
      finish.resolve();
      const assertCompleted = async () => {
        await expect(run).toHaveAttribute("data-status", "completed");
        await expect(run.locator(".assistant-message-row > .answer")).toHaveText("已完成的查询结果");
        await expect(run.getByTestId("progress")).toHaveAttribute("aria-expanded", "false");
        await expect(run.getByTestId("process")).toHaveCount(0);
        await expect(run.getByTestId("thinking-block")).toHaveCount(0);
      };
      await assertCompleted();
      await run.getByTestId("progress").click();
      await expect(run.getByTestId("thinking-block")).toHaveCount(1);
      expect(
        await run.evaluate((element) => {
          const thought = element.querySelector('[data-testid="thinking-block"]');
          const answer = element.querySelector(".assistant-message-row > .answer");
          return Boolean(
            thought && answer && thought.compareDocumentPosition(answer) & Node.DOCUMENT_POSITION_FOLLOWING,
          );
        }),
      ).toBe(true);
      await run.getByTestId("progress").click();
      if (pane === "main") {
        await page.reload();
        await assertCompleted();
      } else {
        // Side-chat tabs are transient. Restart the host and read the persisted child through IPC.
        const childId = await target.getAttribute("data-side-chat-session");
        if (!childId) throw new Error("Missing side chat session");
        await app.close();
        app = await launchDesktop({ dir, url: server.url });
        const restoredPage = await app.firstWindow();
        const snapshot = await restoredPage.evaluate((id) => window.zpi.getSessionSnapshot(id), childId);
        if (!snapshot.ok) throw new Error(snapshot.error.message);
        const restored = snapshot.value.view.runs.at(-1);
        if (!restored) throw new Error("Missing restored reply");
        expect(restored.status).toBe("completed");
        expect(runPresentation(restored)).toMatchObject({
          answer: { text: "已完成的查询结果" },
          process: [expect.objectContaining({ type: "thinking", text: "Awaiting user input" })],
          defaultOpen: false,
        });
      }
    } finally {
      finish.resolve();
      await runCleanup([
        () => rm(dir, { recursive: true, force: true }),
        () => server.close(),
        () => app?.close(),
      ]);
    }
  });
}

for (const streamingPane of ["main", "side"] as const) {
  test(`auxiliary selection stays open and adds to its own draft while ${streamingPane} streams`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-streaming-selection-"));
    const steps = [deferred(), deferred()];
    const finish = deferred();
    const server = await fakeServer(async (_, response, index) => {
      if (index < 2) {
        send(response, chunk({ content: "可以引用的完整回答" }));
      } else {
        send(response, chunk({ content: "正在流式回复" }));
        for (const [index, step] of steps.entries()) {
          await step.promise;
          send(response, chunk({ content: ` 增量${index + 1}` }));
        }
        await finish.promise;
      }
      done(response);
    });
    let app: Awaited<ReturnType<typeof launchDesktop>>;
    try {
      app = await launchDesktop({ dir, url: server.url });
      const page = await app.firstWindow();
      const main = page.locator("main");
      await main.getByLabel("消息", { exact: true }).fill("主问题");
      await main.getByLabel("发送", { exact: true }).click();
      await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
      await page.getByLabel("展开右侧栏", { exact: true }).click();
      await page
        .locator(".pane-empty-launcher")
        .getByRole("button", { name: "辅助对话", exact: true })
        .click();
      const side = page.getByRole("region", { name: "辅助对话", exact: true });
      await side.getByLabel("消息", { exact: true }).fill("辅助问题");
      await side.getByLabel("发送", { exact: true }).click();
      await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
      const streaming = streamingPane === "main" ? main : side;
      await streaming.getByLabel("消息", { exact: true }).fill("继续回复");
      await streaming.getByLabel("发送", { exact: true }).click();
      await expect(streaming.getByTestId("run").last()).toHaveAttribute("data-status", "running");
      await expect(streaming.getByTestId("run").last()).toContainText("正在流式回复");
      const paragraph = side.getByTestId("run").first().locator(".answer p");
      await paragraph.click();
      await paragraph.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
      const menu = page.getByRole("toolbar", { name: "选文操作", exact: true });
      const add = menu.getByRole("button", { name: "添加到当前辅助对话", exact: true });
      await expect(add).toBeVisible();
      await menu.evaluate((element) => {
        element.dataset.streamAnchor = "original-menu";
      });
      for (const [index, step] of steps.entries()) {
        step.resolve();
        await expect(streaming.getByTestId("run").last()).toContainText(`增量${index + 1}`);
        await expect(add).toBeVisible();
        await expect(menu).toHaveAttribute("data-stream-anchor", "original-menu");
        expect(await page.evaluate(() => window.getSelection()?.toString())).toBe("可以引用的完整回答");
      }
      await add.click();
      await expect(side.getByLabel("消息", { exact: true })).toBeFocused();
      await expect(side.locator(".composer-container .selection-reference-chip")).toHaveAttribute(
        "data-conversation-selection-reference-count",
        "1",
      );
      await expect(main.locator(".composer-container .selection-reference-chip")).toHaveCount(0);
      finish.resolve();
      await expect(streaming.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
      await expect(side.locator(".composer-container .selection-reference-chip")).toHaveAttribute(
        "data-conversation-selection-reference-count",
        "1",
      );
    } finally {
      for (const step of steps) step.resolve();
      finish.resolve();
      await runCleanup([
        () => rm(dir, { recursive: true, force: true }),
        () => server.close(),
        () => app?.close(),
      ]);
    }
  });
}

test("side chats fit narrow panes, add references to their own draft and copy only the message body", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-chat-layout-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "可以引用的辅助回答" }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("主问题");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await main.getByLabel("消息", { exact: true }).fill("保留主草稿");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await expect(side).toBeVisible();
    for (const size of [
      [1200, 800],
      [900, 640],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        size,
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(size[0]);
      await expect
        .poll(() => side.locator(".conversation").evaluate((el) => el.scrollWidth - el.clientWidth))
        .toBe(0);
      await expect(side.getByLabel("消息", { exact: true })).toBeInViewport();
    }
    const sideComposer = side.locator(".composer");
    const withoutMetrics = await sideComposer.boundingBox();
    await side.getByLabel("消息", { exact: true }).fill("辅助问题");
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    expect(await sideComposer.boundingBox()).toEqual(withoutMetrics);
    const metrics = side.getByTestId("model-performance");
    await expect(metrics).toBeVisible();
    const inputBox = await sideComposer.boundingBox();
    const metricBox = await metrics.boundingBox();
    const dockBox = await side.locator(".composer-container").boundingBox();
    expect(inputBox && metricBox && dockBox).toBeTruthy();
    if (inputBox && metricBox && dockBox) {
      expect(metricBox.y).toBeGreaterThanOrEqual(inputBox.y + inputBox.height);
      expect(metricBox.y + metricBox.height).toBeLessThanOrEqual(dockBox.y + dockBox.height);
    }
    await side.locator(".composer-container").screenshot({
      path: "test-results/model-performance-side-composer.png",
    });
    await side.getByLabel("消息", { exact: true }).fill("保留辅助草稿");
    const paragraph = side.locator(".answer p");
    await paragraph.evaluate((element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    const menu = page.getByRole("toolbar", { name: "选文操作", exact: true });
    await menu.getByRole("button", { name: "添加到当前辅助对话", exact: true }).click();
    await expect(side.getByLabel("消息", { exact: true })).toBeFocused();
    await expect(side.getByLabel("消息", { exact: true })).toHaveText("保留辅助草稿");
    await expect(side.locator(".selection-reference-chip")).toHaveAttribute(
      "data-conversation-selection-reference-count",
      "1",
    );
    await expect(main.getByLabel("消息", { exact: true })).toHaveText("保留主草稿");
    await expect(main.locator(".selection-reference-chip")).toHaveCount(0);
    await page.screenshot({ path: "test-results/side-chat-selection.png" });
    const previousRuns = await side.getByTestId("run").count();
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run")).toHaveCount(previousRuns + 1);
    await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("# userselect:");
    expect(JSON.stringify(server.requests.at(-1)?.messages)).toContain("可以引用的辅助回答");
    const quotedRun = side.getByTestId("run").last();
    await expect(quotedRun.locator(".user-message-text")).toHaveText("保留辅助草稿");
    await quotedRun.locator(".user-message-actions").getByLabel("复制", { exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("保留辅助草稿");
    const composer = side.getByLabel("消息", { exact: true });
    await composer.focus();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    await composer.evaluate((element, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      element.dispatchEvent(
        new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
      );
    }, copied);
    await expect(composer).toHaveText("保留辅助草稿");
    await expect(side.locator(".composer-container .selection-reference-chip")).toHaveCount(0);
    await expect(quotedRun.locator(".selection-reference-chip")).toHaveAttribute(
      "data-conversation-selection-reference-count",
      "1",
    );
    await composer.fill("");
    await side
      .getByTestId("run")
      .first()
      .locator(".answer p")
      .evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
        element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      });
    await page
      .getByRole("toolbar", { name: "选文操作", exact: true })
      .getByRole("button", { name: "添加到当前辅助对话", exact: true })
      .click();
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(side.getByTestId("run").last().locator(".user-message-text")).toBeEmpty();
    await expect(
      side.getByTestId("run").last().locator(".user-message-actions").getByLabel("复制", { exact: true }),
    ).toBeDisabled();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("window drag regions never overlap floating toggles or header buttons while find is open", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-titlebar-find-"));
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page
      .locator("main")
      .getByLabel("消息", { exact: true })
      .press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    const find = page.getByRole("dialog", { name: "在任务中查找", exact: true });
    await expect(find).toBeVisible();
    const assertDisjointRegions = async () => {
      await expect
        .poll(() =>
          page.evaluate(() => {
            const regions = [
              ...document.querySelectorAll<HTMLElement>(
                ".sidebar-drag-space,.topbar-title,.topbar-drag-space,.pane-drag-space",
              ),
            ].filter(
              (element) =>
                element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
            );
            const controls = [
              ...document.querySelectorAll<HTMLElement>(
                ".window-chrome-button,.topbar button,.pane-header button",
              ),
            ].filter(
              (element) =>
                element.getBoundingClientRect().width > 0 && element.getBoundingClientRect().height > 0,
            );
            return regions.flatMap((region) =>
              controls.flatMap((control) => {
                const a = region.getBoundingClientRect();
                const b = control.getBoundingClientRect();
                return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top
                  ? [`${region.className}: ${control.getAttribute("aria-label") ?? control.className}`]
                  : [];
              }),
            );
          }),
        )
        .toEqual([]);
    };
    for (const selector of [".topbar", ".pane-header"]) {
      await expect(page.locator(selector)).toHaveCSS("app-region", "no-drag");
      const header = await page.locator(selector).boundingBox();
      const overlay = await find.boundingBox();
      expect(header && overlay && header.y + header.height <= overlay.y).toBe(true);
    }
    await expect(page.locator(".desktop-top-controls")).toHaveCSS("app-region", "no-drag");
    await expect(page.locator(".topbar-title")).toHaveCSS("app-region", "drag");
    await expect(page.locator(".topbar-drag-space")).toHaveCSS("app-region", "drag");
    await expect(page.getByLabel("收起右侧栏", { exact: true })).toHaveCSS("app-region", "no-drag");
    await expect(find).toHaveCSS("app-region", "no-drag");
    await assertDisjointRegions();
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await assertDisjointRegions();
    await page.getByLabel("收起侧边栏", { exact: true }).click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await assertDisjointRegions();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeVisible();
    await assertDisjointRegions();
    await find.getByRole("button", { name: "关闭查找", exact: true }).click();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
