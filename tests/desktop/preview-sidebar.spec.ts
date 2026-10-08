import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("terminal cards use real turn changes, IPC file validation and native/browser/file opens", async () => {
  test.setTimeout(60000);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-preview-cards-")));
  const project = join(dir, "中文 项目");
  await mkdir(project);
  await writeFile(join(project, "existing.md"), "# Existing\n");
  await writeFile(join(project, "slides.pptx"), "presentation fixture");
  const release = deferred();
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const user = messages.filter((m) => m.role === "user").at(-1)?.content;
    if (user === "生成预览" && !messages.some((m) => m.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "html",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "页面 demo.html", content: "<h1>真实 HTML 预览</h1>" }),
              },
            },
            {
              index: 1,
              id: "md",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "报告.md", content: "# 真实 Markdown 预览\n" }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else if (user === "生成预览") {
      send(
        response,
        chunk({
          content:
            "已生成 [页面](<./页面 demo.html>) 和 [报告](报告.md)。另有 `slides.pptx`、`missing.pdf`。",
        }),
      );
      return release.promise.then(() => done(response));
    } else if (user === "网址") {
      send(
        response,
        chunk({
          content:
            "预览 [动态页面](http://localhost:43210/route?q=1)。普通网站 https://example.com 不生成卡片。",
        }),
      );
      done(response);
    } else {
      send(response, chunk({ content: "仅讨论 `existing.md` 和 `页面 demo.html`，没有修改。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({
      dir,
      project,
      url: server.url,
      packaged: Boolean(process.env.ZPI_TEST_PACKAGED_APP),
    });
    const page = await app.firstWindow();
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await app.evaluate(({ BrowserWindow, shell }) => {
      BrowserWindow.getAllWindows()[0].setSize(1200, 800);
      const calls: string[] = [];
      (globalThis as typeof globalThis & { previewCalls: string[] }).previewCalls = calls;
      shell.openPath = async (path) => {
        calls.push(path);
        return "";
      };
      shell.showItemInFolder = (path) => {
        calls.push(`reveal:${path}`);
      };
      shell.openExternal = async (url) => {
        calls.push(url);
      };
    });
    const calls = () =>
      app?.evaluate(() => (globalThis as typeof globalThis & { previewCalls: string[] }).previewCalls);
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("生成预览");
    await editor.press("Enter");
    await expect(page.locator(".answer")).toContainText("已生成");
    await expect(page.locator(".assistant-preview-card")).toHaveCount(0);
    release.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const cards = page.locator(".assistant-preview-card");
    await expect(cards).toHaveCount(3);
    await expect(cards.locator(".assistant-preview-title")).toHaveText([
      "slides.pptx",
      "报告.md",
      "页面 demo.html",
    ]);
    await expect(cards.locator(".assistant-preview-subtitle")).toHaveText([
      "演示文稿 · PPTX",
      "文档 · MD",
      "网站 · HTML",
    ]);
    expect(
      await cards.evaluateAll((nodes) =>
        nodes.map((node) => {
          const style = getComputedStyle(node);
          return [style.animationDuration, style.animationDelay];
        }),
      ),
    ).toEqual([
      ["0.9s", "0s"],
      ["0.9s", "0.036s"],
      ["0.9s", "0.072s"],
    ]);
    await expect.poll(calls).toEqual([join(project, "slides.pptx")]);
    await expect
      .poll(() =>
        cards
          .locator("img")
          .first()
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
    await page.screenshot({ path: "test-results/previews-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/previews-dark.png" });
    const md = cards.filter({ hasText: "文档 · MD" });
    await md.getByRole("button", { name: "打开", exact: true }).click();
    await expect(page.locator(".file-markdown-preview")).toContainText("真实 Markdown 预览");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await md.getByLabel("选择打开方式").click();
    await expect(page.getByRole("menuitem", { name: "Finder", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/preview-open-menu.png" });
    await page.getByRole("menuitem", { name: "复制相对路径" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toBe("报告.md");
    await md.getByLabel("选择打开方式").click();
    await page.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(calls).toContain(`reveal:${join(project, "报告.md")}`);
    const html = cards.filter({ hasText: "网站 · HTML" });
    await html.getByRole("button", { name: "打开", exact: true }).click();
    await expect
      .poll(() =>
        app?.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((wc) => decodeURI(wc.getURL()).endsWith("页面 demo.html")),
        ),
      )
      .toBe(true);
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await html.getByLabel("选择打开方式").click();
    await page.getByRole("menuitem", { name: "在浏览器中打开" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(calls).toContain(join(project, "页面 demo.html"));
    await editor.fill("讨论");
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("run").last().locator(".assistant-preview-card")).toHaveCount(0);
    await editor.fill("网址");
    await editor.press("Enter");
    const website = page.getByTestId("run").last().locator(".assistant-preview-card");
    await expect(website).toHaveCount(1);
    await website.getByRole("button", { name: "打开", exact: true }).click();
    await expect
      .poll(() =>
        app?.evaluate(({ webContents }) =>
          webContents.getAllWebContents().some((wc) => wc.getURL() === "http://localhost:43210/route?q=1"),
        ),
      )
      .toBe(true);
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await website.getByLabel("选择打开方式").click();
    await page.getByRole("menuitem", { name: "在浏览器中打开" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect.poll(calls).toContain("http://localhost:43210/route?q=1");
    await page.reload();
    await expect(page.locator(".assistant-preview-card")).toHaveCount(4);
    expect((await calls())?.filter((path) => path.endsWith("slides.pptx"))).toHaveLength(1);
  } finally {
    release.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("independent project/task/timeline pages, menu keyboard navigation, preferences and real task selection", async () => {
  test.setTimeout(60000);
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-sidebar-pages-")));
  const now = new Date("2026-10-08T12:00:00+08:00").getTime();
  const projects = ["alpha", "beta"].map((id) => ({ id, name: id, path: join(dir, id), updatedAt: now }));
  await Promise.all(projects.map((p) => mkdir(p.path)));
  await writeFile(join(dir, "projects.json"), JSON.stringify(projects));
  for (const [scope, count] of [
    ["alpha", 11],
    ["beta", 6],
    [null, 41],
  ] as const) {
    for (let i = 0; i < count; i++) {
      const seeded = seedHistory(dir, projects.find((p) => p.id === scope)?.path ?? dir, 1, {
        projectId: scope,
      });
      const lines = (await readFile(seeded.file, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      for (const line of lines) {
        line.timestamp = new Date(now - i * 86400000).toISOString();
        if (line.type === "session") line.timestamp = new Date(now - (count - i) * 86400000).toISOString();
        if (line.type === "session_info")
          line.name = `${scope ?? "任务"} ${String(i).padStart(2, "0")} 完整标题用于窄侧栏渐隐显示`;
        if (line.customType === "ZPI.run") {
          line.data.startedAt = now - i * 86400000;
          if (line.data.phase === "end") line.data.endedAt = now - i * 86400000;
        }
      }
      await writeFile(seeded.file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`);
    }
  }
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "", packaged: Boolean(process.env.ZPI_TEST_PACKAGED_APP) });
    let page = await app.firstWindow();
    await page.clock.setFixedTime(now);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    const alpha = page.locator('[data-project-id="alpha"]');
    const beta = page.locator('[data-project-id="beta"]');
    await expect(alpha.getByTestId("session-row")).toHaveCount(5);
    await expect(beta.getByTestId("session-row")).toHaveCount(5);
    await alpha.getByText("显示更多", { exact: true }).click();
    await expect(alpha.getByTestId("session-row")).toHaveCount(10);
    await expect(beta.getByTestId("session-row")).toHaveCount(5);
    await alpha.getByText("显示更多", { exact: true }).click();
    await expect(alpha.getByTestId("session-row")).toHaveCount(11);
    await expect(alpha.getByText("显示更多", { exact: true })).toHaveCount(0);
    await beta.getByText("显示更多", { exact: true }).click();
    await expect(beta.getByTestId("session-row")).toHaveCount(6);
    await page.getByLabel("收起项目 alpha", { exact: true }).click();
    await page.getByLabel("展开项目 alpha", { exact: true }).click();
    await expect(alpha.getByTestId("session-row")).toHaveCount(5);
    const tasks = page.locator(".recent-sessions");
    await expect(tasks.getByTestId("session-row")).toHaveCount(20);
    await expect(tasks.locator(".timeline-group-label")).toHaveCount(0);
    await tasks.getByText("显示更多", { exact: true }).click();
    await expect(tasks.getByTestId("session-row")).toHaveCount(40);
    await tasks.getByText("显示更多", { exact: true }).click();
    await expect(tasks.getByTestId("session-row")).toHaveCount(41);
    await expect(tasks.getByText("显示更多", { exact: true })).toHaveCount(0);
    const filter = page.getByLabel("筛选和排序", { exact: true });
    await filter.click();
    await expect(page.getByRole("menuitemradio", { name: "按项目" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: "更新时间" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.getByRole("menuitemradio", { name: "创建时间" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(alpha.locator(".session-name").first()).toContainText("alpha 10");
    await expect(alpha.locator(".task-row-time").first()).toHaveText("10天");
    await expect(tasks.getByTestId("session-row")).toHaveCount(20);
    await filter.click();
    await page.getByRole("menuitemradio", { name: "时间线" }).click();
    await expect(page.getByRole("menu")).toHaveCount(0);
    const timeline = page.locator(".timeline-tasks");
    await expect(timeline.getByTestId("session-row")).toHaveCount(20);
    await expect(timeline.locator(".timeline-group-label").first()).toHaveText("昨天");
    await timeline.getByText("显示更多", { exact: true }).click();
    await expect(timeline.getByTestId("session-row")).toHaveCount(40);
    await timeline.getByText("显示更多", { exact: true }).click();
    await expect(timeline.getByTestId("session-row")).toHaveCount(58);
    await expect(timeline.getByText("显示更多", { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(timeline.getByTestId("session-row")).toHaveCount(20);
    await filter.click();
    await expect(page.getByRole("menuitemradio", { name: "时间线" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: "创建时间" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await page.screenshot({ path: "test-results/sidebar-sort-menu.png" });
    await page.keyboard.press("Escape");
    await expect(filter).toBeFocused();
    await timeline.locator(".session-name").first().click();
    await expect(page.getByTestId("run")).toHaveCount(1);
    await page.getByLabel("消息", { exact: true }).focus();
    await page.mouse.move(1100, 700);
    await expect(timeline.locator(".task-row-time").first()).toBeVisible();
    await page.emulateMedia({ colorScheme: "light" });
    await page.screenshot({ path: "test-results/sidebar-timeline-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/sidebar-timeline-dark.png" });
    await app.close();
    app = await launchDesktop({ dir, url: "", packaged: Boolean(process.env.ZPI_TEST_PACKAGED_APP) });
    page = await app.firstWindow();
    await page.getByLabel("筛选和排序", { exact: true }).click();
    await expect(page.getByRole("menuitemradio", { name: "时间线" })).toHaveAttribute("aria-checked", "true");
    await expect(page.getByRole("menuitemradio", { name: "创建时间" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  } finally {
    await app?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
