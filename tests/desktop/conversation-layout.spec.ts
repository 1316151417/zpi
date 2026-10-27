import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("ZCode turn actions stay near the composer and share the turn hover area at every column width", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-conversation-layout-"));
  const text = Array.from(
    { length: 45 },
    (_, index) => `第 ${index + 1} 段：检查正文、操作栏和输入栏的布局。`,
  ).join("\n\n");
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: text }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("检查消息布局");
    await page.getByLabel("发送", { exact: true }).click();
    const run = page.getByTestId("run");
    const area = page.locator(".conversation");
    const actions = run.locator(".assistant-message-actions");
    await expect(run).toHaveAttribute("data-status", "completed");
    for (const [width, height] of [
      [1200, 800],
      [1140, 720],
      [900, 640],
      [1600, 900],
    ]) {
      await app.evaluate(
        ({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setSize(size[0], size[1]),
        [width, height],
      );
      await expect.poll(() => page.evaluate(() => innerWidth)).toBe(width);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const column = document.querySelector(".conversation-inner");
            const dock = document.querySelector(".composer-container");
            return column && dock
              ? dock.getBoundingClientRect().width - column.getBoundingClientRect().width
              : null;
          }),
        )
        .toBe(0);
      await area.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      await expect
        .poll(() =>
          page.evaluate(() => {
            const row = document.querySelector(".assistant-message-actions");
            const composer = document.querySelector(".composer-container > .composer-stack > .composer");
            if (!row || !composer) throw new Error("Missing message actions or composer");
            return composer.getBoundingClientRect().top - row.getBoundingClientRect().bottom;
          }),
        )
        .toBe(20);
      const geometry = await page.evaluate(() => {
        const body = document.querySelector(".task-body");
        const conversation = document.querySelector(".conversation");
        const column = document.querySelector(".conversation-inner");
        const dock = document.querySelector(".composer-container");
        const answer = document.querySelector(".assistant-message-row > .answer");
        const input = document.querySelector(".composer-container > .composer-stack > .composer");
        if (!body || !conversation || !column || !dock || !answer || !input)
          throw new Error("Missing conversation layout");
        return {
          availableWidth: conversation.clientWidth,
          columnWidth: column.getBoundingClientRect().width,
          dockWidth: dock.getBoundingClientRect().width,
          columnLeft: column.getBoundingClientRect().left,
          dockLeft: dock.getBoundingClientRect().left,
          textInset: answer.getBoundingClientRect().left - column.getBoundingClientRect().left,
          inputInset: input.getBoundingClientRect().left - dock.getBoundingClientRect().left,
        };
      });
      const expectedWidth =
        geometry.availableWidth >= 1280
          ? Math.min(geometry.availableWidth - 384, 1152)
          : geometry.availableWidth >= 864
            ? Math.min(geometry.availableWidth - 96, 896)
            : geometry.availableWidth;
      expect(geometry.columnWidth).toBe(expectedWidth);
      expect(geometry.dockWidth).toBe(expectedWidth);
      expect(geometry.columnLeft).toBe(geometry.dockLeft);
      expect(geometry.textInset).toBe(geometry.availableWidth >= 448 ? 24 : 16);
      expect(geometry.inputInset).toBe(16);
      await page.mouse.move(0, 0);
      await expect(actions).toHaveCSS("opacity", "0");
      const input = await page.locator(".composer-container > .composer-stack > .composer").boundingBox();
      const row = await actions.boundingBox();
      if (!input || !row) throw new Error("Missing action hover target");
      // Moving just above the 20px turn footer must hit the full action row.
      await page.mouse.move(row.x + 12, input.y - 21);
      await expect(actions).toHaveCSS("opacity", "1");
      await page.screenshot({ path: `test-results/conversation-footer-${width}.png` });
    }
    await run.getByTestId("progress").scrollIntoViewIfNeeded();
    await run.getByTestId("progress").hover();
    await expect(actions).toHaveCSS("opacity", "1");
    await actions.getByLabel("复制", { exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
    await page.getByLabel("消息", { exact: true }).focus();
    await page.mouse.move(0, 0);
    await expect(actions).toHaveCSS("opacity", "0");
    await actions.getByLabel("复制", { exact: true }).focus();
    await expect(actions).toHaveCSS("opacity", "1");
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/conversation-footer-dark.png" });
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("composer stays centered when switching running tasks and drafts without resizing the window", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-composer-session-layout-"));
  const finish = deferred();
  const server = await fakeServer(async (_, response) => {
    send(response, chunk({ content: "流式输出中的长对话。\n\n".repeat(60) }));
    await finish.promise;
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1512, 894));
    await page.evaluate(() => window.zpi.updatePreferences({ sidebarWidth: 342.328125 }));
    await page.reload();
    const editor = page.getByLabel("消息", { exact: true });
    const ids: string[] = [];
    for (const name of ["布局任务 A", "布局任务 B"]) {
      await editor.fill(name);
      await editor.press("Enter");
      await expect(page.locator("main .answer")).toContainText("流式输出中的长对话。");
      const id = await page.evaluate(() => localStorage.getItem("zpi.selectedSession"));
      if (!id) throw new Error("Missing running session");
      ids.push(id);
      await page.getByLabel("新建任务", { exact: true }).first().click();
      await expect(page.locator("main")).toHaveClass(/draft-main/);
    }
    for (const classic of [false, true]) {
      const fallback = classic
        ? await page.addStyleTag({ content: "main .conversation { scrollbar-color: auto; }" })
        : undefined;
      for (const id of [...ids, ...ids.toReversed()]) {
        await page.locator(`.sidebar .session-row[data-session-id="${id}"]`).click();
        await expect(page.locator("main")).not.toHaveClass(/draft-main/);
        await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
        await expect
          .poll(() =>
            page.evaluate(() => {
              const column = document.querySelector("main .conversation-inner")?.getBoundingClientRect();
              const composer = document.querySelector("main .composer-container")?.getBoundingClientRect();
              if (!column || !composer) return null;
              return { left: composer.left - column.left, width: composer.width - column.width };
            }),
          )
          .toEqual({ left: 0, width: 0 });
        await page.getByLabel("新建任务", { exact: true }).first().click();
        await expect(page.locator("main")).toHaveClass(/draft-main/);
        await expect(editor).toBeInViewport();
      }
      await fallback?.evaluate((element) => element.parentNode?.removeChild(element));
    }
    await page.locator(`.sidebar .session-row[data-session-id="${ids[0]}"]`).click();
    await page.screenshot({ path: test.info().outputPath("composer-after-session-switch.png") });
  } finally {
    finish.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("task status keeps the composer aligned across scrollbar and panel breakpoints", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-composer-status-layout-"));
  const finish = deferred();
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as { role: string }[];
    if (messages.some((message) => message.role === "tool")) {
      send(response, chunk({ content: "检查输入框对齐。\n\n".repeat(60) }));
      await finish.promise;
      done(response);
      return;
    }
    send(
      response,
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "layout-task",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({ command: "echo done", run_in_background: true }),
            },
          },
        ],
      }),
    );
    done(response, "tool_calls");
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("检查任务状态面板旁的输入框布局");
    await editor.press("Enter");
    await expect(page.locator("main .answer").first()).toContainText("检查输入框对齐。");
    await expect(page.getByTestId("run").first()).toHaveAttribute("data-status", "running");
    const panel = page.getByRole("complementary", { name: "任务状态", exact: true });
    await expect(panel).toBeVisible();
    const body = page.locator("main .task-body");
    const column = page.locator("main .conversation-inner");
    const dock = page.locator("main .composer-container");
    const outsideWidth = await body.evaluate((element) => innerWidth - element.getBoundingClientRect().width);
    // Exercise classic scrollbars even on macOS with overlay scrollbars enabled.
    // Auto color uses the app's WebKit fallback, which reserves a 14px gutter.
    const scrollbars = await page.addStyleTag({ content: "main .conversation { scrollbar-color: auto; }" });
    for (const gutter of [true, false]) {
      if (!gutter) {
        finish.resolve();
        await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
        await scrollbars.evaluate((element) => element.parentNode?.removeChild(element));
      }
      for (const width of [1279, 1280, 1293, 1294, 1320, 1500, 1279]) {
        await app.evaluate(
          ({ BrowserWindow }, width) => BrowserWindow.getAllWindows()[0].setSize(width, 900),
          Math.round(outsideWidth + width),
        );
        await expect.poll(() => body.evaluate((element) => element.clientWidth)).toBe(width);
        if (gutter) {
          await expect
            .poll(() =>
              page
                .locator("main .conversation")
                .evaluate((element) => (element as HTMLElement).offsetWidth - element.clientWidth),
            )
            .toBe(14);
        }
        for (const mode of ["auto", "mini", "panel"] as const) {
          if (mode === "mini") {
            const expand = panel.getByLabel("展开状态", { exact: true });
            if (await expand.isVisible()) await expand.click();
            await panel.getByLabel("收起为胶囊", { exact: true }).click();
          }
          if (mode === "panel" || (mode === "auto" && width < 1280))
            await panel.getByLabel("展开状态", { exact: true }).click();
          if (mode === "auto") {
            await panel.getByLabel("状态面板展开策略", { exact: true }).click();
            await page.getByRole("menuitemradio", { name: "自动展开", exact: true }).click();
          }
          await expect(panel).toHaveAttribute("data-display-mode", mode);
          await expect(column).toHaveCSS(
            "transform",
            width >= 1280 && mode !== "mini" ? "matrix(1, 0, 0, 1, -168, 0)" : "none",
          );
          await expect
            .poll(async () => {
              const message = await column.boundingBox();
              const composer = await dock.boundingBox();
              if (!message || !composer) throw new Error("Missing conversation column or composer");
              return { left: composer.x - message.x, width: composer.width - message.width };
            })
            .toEqual({ left: 0, width: 0 });
          await expect(editor).toBeInViewport();
          if (width === 1280 && mode === "auto")
            await page.screenshot({
              path: test.info().outputPath(`composer-alignment-gutter-${gutter}.png`),
            });
        }
        // Restore automatic mode before resizing across the next breakpoint.
        await panel.getByLabel("状态面板展开策略", { exact: true }).click();
        await page.getByRole("menuitemradio", { name: "自动展开", exact: true }).click();
      }
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
