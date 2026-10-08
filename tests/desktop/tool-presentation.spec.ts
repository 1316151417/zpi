import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

const call = (id: string, name: string, args: Record<string, unknown>, index = 0) => ({
  index,
  id,
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});

test("long grouped commands keep the running label separate while rolling and at narrow widths", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-tool-summary-spacing-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "a.ts"), "export const a = 1;\n");
  const finish = deferred();
  const path = "trusteeship-performance-model/src/main/java/com/ke/".repeat(8);
  const exploreCommand = `git log --since="2025-09-01" --pretty=format:"%an" -- ${path}; while [ ! -f explore-release ]; do sleep 0.05; done`;
  const executeCommand = `printf '%s' '${path}'; while [ ! -f execute-release ]; do sleep 0.05; done`;
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(response, chunk({ tool_calls: [call("read", "read", { path: "a.ts" })] }));
    } else if (index === 1) {
      send(response, chunk({ tool_calls: [call("explore", "bash", { command: exploreCommand })] }));
    } else if (index === 2) {
      send(response, chunk({ reasoning_content: "查阅完成，执行命令。" }));
      send(
        response,
        chunk({
          tool_calls: [
            call("execute-first", "bash", { command: "printf first" }),
            call("execute-long", "bash", { command: executeCommand }, 1),
          ],
        }),
      );
    } else {
      await finish.promise;
      send(response, chunk({ content: "完成。" }));
      done(response);
      return;
    }
    done(response, "tool_calls");
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("检查长命令摘要间距");
    await page.getByLabel("发送", { exact: true }).click();
    for (const [kind, command] of [
      ["explore", exploreCommand],
      ["execute", executeCommand],
    ] as const) {
      const group = page.locator(`[data-tool-group="${kind}"]`);
      const summary = group.locator(":scope > .tool-layout > .tool-summary-row");
      await expect(summary.locator(".tool-command-summary").last()).toHaveText(command);
      // Sample rendered geometry throughout the rolling transition and hold.
      const gaps = await summary.evaluate(async (el, command) => {
        const gaps: number[] = [];
        const start = performance.now();
        while (performance.now() - start < 900) {
          for (const code of el.querySelectorAll(".tool-command-summary")) {
            if (code.textContent !== command) continue;
            const label =
              code.previousElementSibling?.querySelector(".tool-active-label") ?? code.previousElementSibling;
            if (label) gaps.push(code.getBoundingClientRect().left - label.getBoundingClientRect().right);
          }
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
        return gaps;
      }, command);
      expect(gaps.length).toBeGreaterThan(0);
      expect(Math.min(...gaps)).toBeGreaterThanOrEqual(7);
      for (const reducedMotion of ["no-preference", "reduce"] as const) {
        await page.emulateMedia({ reducedMotion });
        for (const width of [700, 350]) {
          await page.locator(".conversation").evaluate((el, width) => {
            (el as HTMLElement).style.width = `${width}px`;
          }, width);
          const label = summary.locator(".tool-active-label");
          const code = summary.locator(".tool-command-summary");
          await expect(label).toHaveText("正在执行");
          await expect(code).toHaveText(command);
          const labelBox = await label.boundingBox();
          const commandBox = await code.boundingBox();
          expect(labelBox).not.toBeNull();
          expect(commandBox).not.toBeNull();
          if (!labelBox || !commandBox) throw new Error("Missing running label or command");
          expect(commandBox.x - (labelBox.x + labelBox.width)).toBeGreaterThanOrEqual(7);
          expect(await code.evaluate((el) => el.scrollWidth)).toBeGreaterThan(commandBox.width);
          expect(await summary.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(1);
        }
      }
      await page.screenshot({ path: `test-results/tool-summary-${kind}-long-command.png` });
      await summary.click();
      await expect(summary).not.toContainText("正在执行");
      await summary.click();
      await expect(summary.locator(".tool-active-label")).toHaveText("正在执行");
      await page.locator(".conversation").evaluate((el) => {
        (el as HTMLElement).style.width = "";
      });
      await page.emulateMedia({ reducedMotion: "no-preference" });
      await writeFile(join(project, `${kind}-release`), "");
    }
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
  } finally {
    finish.resolve();
    await writeFile(join(project, "explore-release"), "");
    await writeFile(join(project, "execute-release"), "");
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("ZCode tool summaries group by phase, preserve expansion and open per-operation diffs", async () => {
  test.setTimeout(60_000);
  const dir = await mkdtemp(join(tmpdir(), "ZPI-tool-presentation-"));
  const project = join(dir, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src/a.ts"), "const value = 'original';\n");
  await writeFile(join(project, "src/b.ts"), "export const b = 2;\n");
  const second = deferred(),
    third = deferred(),
    execute = deferred(),
    edit = deferred(),
    finish = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) send(response, chunk({ tool_calls: [call("read-a", "read", { path: "src/a.ts" })] }));
    else if (index === 1) {
      await second.promise;
      send(response, chunk({ tool_calls: [call("read-b", "read", { path: "src/b.ts" })] }));
    } else if (index === 2) {
      await third.promise;
      send(response, chunk({ tool_calls: [call("missing", "read", { path: "src/missing.ts" })] }));
    } else if (index === 3) {
      send(response, chunk({ reasoning_content: "读取阶段结束。" }));
      await execute.promise;
      send(
        response,
        chunk({
          tool_calls: [
            call("hello", "bash", { command: "printf hello" }),
            call("empty", "bash", { command: "true" }, 1),
          ],
        }),
      );
    } else if (index === 4) {
      await edit.promise;
      send(response, chunk({ reasoning_content: "终端阶段结束。" }));
      send(
        response,
        chunk({
          tool_calls: [
            call("edit-first", "edit", {
              path: "src/a.ts",
              edits: [{ oldText: "original", newText: "intermediate" }],
            }),
            call(
              "edit-second",
              "edit",
              { path: "src/a.ts", edits: [{ oldText: "intermediate", newText: "final" }] },
              1,
            ),
          ],
        }),
      );
    } else {
      send(response, chunk({ content: "检查和编辑完成。" }));
      await finish.promise;
      done(response);
      return;
    }
    done(response, "tool_calls");
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("验证工具摘要");
    await page.getByLabel("发送", { exact: true }).click();
    const tools = page.getByTestId("tool-block");
    await expect(tools).toHaveCount(1);
    await expect(tools.first().getByTestId("tool-summary")).toHaveText("读取a.tssrc/");
    await expect(tools.first().getByTestId("tool-summary")).not.toHaveAttribute("role", "button");
    await expect(tools.first().locator(".process-chevron")).toHaveCount(0);
    await expect(tools.first().locator(".file-type-icon")).toHaveAttribute("src", /typescript\.svg$/);
    await tools.first().getByRole("button", { name: "a.ts", exact: true }).click();
    await expect(page.locator(".file-text-preview")).toContainText("original");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    second.resolve();
    const explore = page.locator('[data-tool-group="explore"]');
    const summary = explore.locator(":scope > .tool-layout > .tool-summary-row");
    await expect(summary).toContainText("查阅·正在读取b.tssrc/");
    await expect(summary).toHaveAttribute("aria-expanded", "false");
    await summary.focus();
    await summary.press("Enter");
    await expect(summary).toHaveText("查阅·2 文件");
    await expect(explore.locator(".tool-group-children > .tool-block")).toHaveCount(2);
    await expect(explore.locator(".tool-block .process-icon")).toHaveCount(0);
    await explore.getByRole("button", { name: "a.ts", exact: true }).click();
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    third.resolve();
    await expect(explore.locator(".tool-group-children > .tool-block")).toHaveCount(3);
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await expect(summary).toHaveText("查阅·3 文件");
    await expect(page.getByTestId("thinking-block")).toHaveCount(1);
    await expect
      .poll(() => explore.locator(".tool-content-shell").evaluate((el) => el.getAnimations().length))
      .toBe(0);
    await explore.locator(".tool-failure").hover();
    await expect(page.locator(".tool-error-content")).toContainText("missing.ts");
    await page.getByRole("button", { name: "复制错误详情", exact: true }).click();
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toContain("missing.ts");
    await expect(summary).toHaveAttribute("aria-expanded", "true");
    await summary.focus();
    await summary.press("Space");
    await expect(summary).toHaveText("查阅·3 文件");
    await expect(summary.locator(".thinking-label-streaming")).toHaveCount(0);
    execute.resolve();
    const terminal = page.locator('[data-tool-group="execute"]');
    const terminalSummary = terminal.locator(":scope > .tool-layout > .tool-summary-row");
    await expect(terminalSummary).toContainText("终端·正在执行true");
    await terminalSummary.click();
    await expect(terminalSummary).toHaveText("终端·2 个命令");
    const commands = terminal.locator(".tool-block");
    await commands.nth(0).getByTestId("tool-summary").click();
    await expect(commands.nth(0).getByTestId("tool-summary")).toHaveText("终端");
    await expect(commands.nth(0).locator(".tool-command")).toHaveText("printf hello");
    await expect(commands.nth(0).locator(".tool-output")).toHaveText("hello");
    await commands.nth(1).getByTestId("tool-summary").click();
    await expect(commands.nth(1).locator(".tool-no-output")).toHaveText("没有输出。");
    edit.resolve();
    const edits = page.locator('[data-tool-name="edit"]');
    await expect(edits).toHaveCount(2);
    await expect(edits.first().locator(".tool-diff-counts")).toHaveText("+1-1");
    await expect(
      edits.first().locator(".tool-diff-counts").getByRole("img", { name: "1" }).first(),
    ).toBeVisible();
    await expect(edits.first().getByTestId("tool-summary")).toHaveAttribute("aria-expanded", "false");
    await edits.first().locator(".tool-kind-label").click();
    await expect(edits.first().locator(".tool-inline-diff")).toContainText("original");
    await expect(edits.first().locator(".tool-inline-diff")).toContainText("intermediate");
    await expect(edits.first().locator(".tool-diff-line.added > code")).not.toContainText("+");
    await expect.poll(() => edits.first().locator(".tool-diff-line code span").count()).toBeGreaterThan(0);
    for (const [index, before, after] of [
      [0, "original", "intermediate"],
      [1, "intermediate", "final"],
    ] as const) {
      await edits.nth(index).getByRole("button", { name: "a.ts", exact: true }).click();
      const diff = page.getByRole("tabpanel", { name: "a.ts", exact: true }).locator("diffs-container");
      await expect(diff).toContainText(before);
      await expect(diff).toContainText(after);
      await expect(diff).not.toContainText(index === 0 ? "final" : "original");
      await page.getByLabel("收起右侧栏", { exact: true }).click();
    }
    await edits.last().locator(".tool-kind-label").click();
    await edits.last().scrollIntoViewIfNeeded();
    await page.screenshot({ path: "test-results/tool-presentation-expanded.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(edits.first().locator(".tool-diff-counts .diff-added")).toHaveCSS(
      "color",
      "rgb(70, 191, 114)",
    );
    await page.screenshot({ path: "test-results/tool-presentation-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.setSize(840, 720);
    });
    // The desktop reserves at least 380px for the chat; exercise the shared row's
    // ZCode container rule below 360px without changing that workbench constraint.
    await page.locator(".conversation").evaluate((el) => {
      (el as HTMLElement).style.width = "350px";
    });
    await expect
      .poll(() => page.locator(".conversation").evaluate((el) => el.clientWidth))
      .toBeLessThanOrEqual(360);
    await expect(edits.first().locator(".tool-file-directory")).toBeHidden();
    await expect(edits.first().locator(".tool-kind-label")).toBeHidden();
    await expect(edits.first().getByRole("button", { name: "a.ts", exact: true })).toBeVisible();
    await expect
      .poll(() => page.getByTestId("process").evaluate((el) => el.scrollWidth - el.clientWidth))
      .toBe(0);
    await page.screenshot({ path: "test-results/tool-presentation-narrow.png" });
    await page.locator(".conversation").evaluate((el) => {
      (el as HTMLElement).style.width = "";
    });
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByTestId("progress").click();
    await expect(summary).toHaveText("查阅·3 文件");
    await expect(terminalSummary).toHaveText("终端·2 个命令");
  } finally {
    for (const gate of [second, third, execute, edit, finish]) gate.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("terminal output follows live data, freezes while reading and preserves completed position", async () => {
  test.setTimeout(60_000);
  const dir = await mkdtemp(join(tmpdir(), "ZPI-tool-output-"));
  const project = join(dir, "project");
  await mkdir(project);
  const finish = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            call("output", "bash", {
              command:
                "for i in $(seq 1 40); do echo line-$i; sleep 0.15; done; while [ ! -f release ]; do sleep 0.1; done; echo final-line",
            }),
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      await finish.promise;
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("输出多行");
    await page.getByLabel("发送", { exact: true }).click();
    const tool = page.getByTestId("tool-block");
    await tool.getByTestId("tool-summary").click();
    const viewport = tool.getByTestId("bash-output-scroll");
    await expect(viewport).toContainText("line-12");
    await expect(viewport).toHaveAttribute("data-following", "true");
    await expect(viewport).toHaveAttribute("data-scroll-mask", "top");
    expect(await viewport.evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(100);
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(viewport).toHaveAttribute("data-following", "false");
    const frozen = await viewport.textContent();
    // The command finishes emitting its first batch while the reader stays at the top.
    await writeFile(join(project, "release"), "");
    await expect.poll(() => server.requests.length).toBe(2);
    await expect(viewport).toHaveText(frozen ?? "");
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0);
    await viewport.evaluate((el) => {
      el.scrollTop = el.scrollHeight;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(viewport).toHaveAttribute("data-following", "true");
    await expect(viewport).toContainText("final-line");
    await expect(viewport).toHaveAttribute("data-scroll-mask", "top");
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
      el.dispatchEvent(new Event("scroll", { bubbles: true }));
    });
    await expect(viewport).toHaveAttribute("data-following", "false");
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByTestId("progress").click();
    await expect(viewport).toHaveAttribute("data-following", "true");
    expect(await viewport.evaluate((el) => el.scrollTop)).toBe(0);
    await page.screenshot({ path: "test-results/tool-output-frozen.png" });
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    const history = await app.firstWindow();
    await history.getByTestId("progress").click();
    await history.getByTestId("tool-summary").click();
    const historicalOutput = history.getByTestId("bash-output-scroll");
    await expect(historicalOutput).toContainText("final-line");
    expect(await historicalOutput.evaluate((el) => el.scrollTop)).toBe(0);
    await expect(historicalOutput).toHaveAttribute("data-scroll-mask", "bottom");
  } finally {
    finish.resolve();
    await writeFile(join(project, "release"), "");
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("write previews load large per-operation patches and failed edits retain readable parameters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-tool-file-preview-"));
  const project = join(dir, "project");
  await mkdir(project);
  const finish = deferred();
  const content = Array.from({ length: 2200 }, (_, i) => `// item_${i} 中文内容中文内容`).join("\n");
  const server = await fakeServer(async (_, response, index) => {
    if (index < 2) {
      const tool =
        index === 0
          ? call("large-write", "write", { path: "large.ts", content })
          : call("failed-edit", "edit", {
              path: "large.ts",
              edits: [{ oldText: "absent-original", newText: "replacement" }],
            });
      send(response, chunk({ tool_calls: [tool] }));
      done(response, "tool_calls");
    } else {
      await finish.promise;
      send(response, chunk({ content: "done" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("写入并尝试编辑");
    await page.getByLabel("发送", { exact: true }).click();
    await expect.poll(() => server.requests.length).toBe(3);
    const write = page.locator('[data-tool-name="write"]');
    await expect(write.getByTestId("tool-summary")).toContainText("写入large.ts+2200");
    await write.locator(".tool-kind-label").click();
    await expect(write.locator(".tool-inline-diff")).toContainText("item_0");
    await expect(write.locator(".tool-inline-diff")).toContainText("item_2199");
    await expect(write.locator(".tool-diff-omitted")).toContainText("Diff 预览已截断");
    expect(await write.locator(".tool-diff-line").count()).toBeLessThanOrEqual(799);
    expect(await write.locator(".tool-inline-diff").evaluate((el) => el.clientHeight)).toBeLessThanOrEqual(
      240,
    );
    const edit = page.locator('[data-tool-name="edit"]');
    await expect(edit.getByTestId("tool-summary")).toContainText("执行失败");
    await expect(edit.getByTestId("tool-summary")).toHaveAttribute("aria-expanded", "false");
    await edit.locator(".tool-kind-label").click();
    await expect(edit.locator(".tool-parameters h4")).toHaveText("Parameters");
    await expect(edit.locator(".tool-parameters h4")).toHaveCSS("text-transform", "uppercase");
    await expect(edit.locator(".tool-input-code")).toContainText("absent-original");
    await expect(edit.locator(".tool-detail-error")).toContainText("Error");
    await expect(edit.locator(".tool-detail-error")).toContainText("Could not find");
    await page.screenshot({ path: "test-results/tool-file-failure.png" });
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
  } finally {
    finish.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
