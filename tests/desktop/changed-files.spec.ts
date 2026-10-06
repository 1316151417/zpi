import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("changed files start collapsed, group repeated edits, scroll within the card and open diffs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-changed-files-"));
  const project = join(dir, "project");
  await mkdir(join(project, "src"), { recursive: true });
  await mkdir(join(project, "tests"));
  const paths = Array.from({ length: 20 }, (_, index) =>
    index === 1
      ? "tests/1.txt"
      : `src/${index === 19 ? "a-long-file-name-that-should-truncate-in-a-narrow-conversation" : index + 1}.txt`,
  );
  await Promise.all(paths.map((path, index) => writeFile(join(project, path), `original ${index}\n`)));
  const release = deferred();
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const results = messages.filter((message) => message.role === "tool");
    const user = messages.filter((message) => message.role === "user").at(-1)?.content;
    if (user === "修改二十个文件" && results.length < 21) {
      const edits =
        results.length === 0
          ? paths.map((path, index) => ({ path, oldText: `original ${index}`, newText: `updated ${index}` }))
          : [{ path: paths[0], oldText: "updated 0", newText: "updated again" }];
      send(
        response,
        chunk({
          tool_calls: edits.map(({ path, oldText, newText }, index) => ({
            index,
            id: `edit-${results.length + index}`,
            type: "function",
            function: { name: "edit", arguments: JSON.stringify({ path, edits: [{ oldText, newText }] }) },
          })),
        }),
      );
      done(response, "tool_calls");
    } else if (user === "修改二十个文件") {
      send(response, chunk({ content: "已修改 20 个文件，其中一个文件修改了两次。" }));
      return release.promise.then(() => done(response));
    } else {
      send(response, chunk({ content: "这一轮没有修改文件。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("修改二十个文件");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    const card = page.locator(".changed-files");
    const summary = card.locator("summary");
    const list = card.locator(".changed-files-list");
    await expect(summary).toContainText("20 个文件");
    await expect(summary.locator(".changed-files-totals")).toHaveText("+21-21");
    await expect(card).not.toHaveAttribute("open");
    await expect(list).toBeHidden();
    await summary.click();
    await expect(list).toBeVisible();
    await expect(card.locator(".changed-file-card")).toHaveCount(20);
    await expect(card.locator(".changed-file-counts").first()).toHaveText("+2-2");
    await expect(card.locator(".changed-file-directory").first()).toHaveText("src/");
    await expect(card.locator(".changed-file-directory").nth(1)).toHaveText("tests/");
    const first = card.locator(".changed-file-row").first();
    const infoBox = await first.locator(".changed-file-info").boundingBox();
    const countsBox = await first.locator(".changed-file-counts").boundingBox();
    expect((countsBox?.x ?? 0) - ((infoBox?.x ?? 0) + (infoBox?.width ?? 0))).toBeLessThanOrEqual(8);
    release.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(card).toHaveAttribute("open", "");
    await summary.focus();
    await summary.press("Space");
    await expect(list).toBeHidden();
    await page.locator(".answer").click();
    await page.screenshot({ path: "test-results/changed-files-collapsed.png" });
    await summary.focus();
    await summary.press("Enter");
    await expect(list).toBeVisible();
    await expect(card.locator(".changed-files-chevron")).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
    await page.locator(".answer").click();
    const bounds = await list.evaluate((element) => ({
      height: element.clientHeight,
      content: element.scrollHeight,
      width: element.clientWidth,
      contentWidth: element.scrollWidth,
    }));
    expect(bounds.height).toBeLessThanOrEqual(320);
    expect(bounds.content).toBeGreaterThan(bounds.height);
    expect(bounds.contentWidth).toBe(bounds.width);
    await page.screenshot({ path: "test-results/changed-files-expanded.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/changed-files-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    const rowBox = await first.boundingBox();
    expect(rowBox).not.toBeNull();
    for (const position of [
      { x: 2, y: 2 },
      { x: (rowBox?.width ?? 0) - 2, y: (rowBox?.height ?? 0) - 2 },
    ]) {
      await first.click({ position });
      await expect(
        page.getByRole("tabpanel", { name: "变更", exact: true }).locator("diffs-container"),
      ).toContainText("original 0");
      await expect(
        page.getByRole("tabpanel", { name: "变更", exact: true }).locator("diffs-container"),
      ).toContainText("updated again");
      await page.getByLabel("收起右侧栏", { exact: true }).click();
    }
    await first.getByRole("button", { name: "查看修改 1.txt", exact: true }).focus();
    await first.getByRole("button", { name: "查看修改 1.txt", exact: true }).press("Enter");
    await expect(
      page.getByRole("tabpanel", { name: "变更", exact: true }).locator("diffs-container"),
    ).toContainText("updated again");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await app.evaluate(({ shell }) => {
      const calls: { action: string; path: string }[] = [];
      (globalThis as typeof globalThis & { fileActionCalls: typeof calls }).fileActionCalls = calls;
      shell.openPath = async (path) => {
        calls.push({ action: "open", path });
        return "";
      };
      shell.showItemInFolder = (path) => {
        calls.push({ action: "reveal", path });
      };
    });
    const recordedActions = () =>
      app?.evaluate(() => (globalThis as typeof globalThis & { fileActionCalls: unknown[] }).fileActionCalls);
    const absolutePath = await realpath(join(project, paths[0]));
    await first.getByRole("button", { name: "打开 1.txt", exact: true }).click();
    await expect(page.locator(".file-text-preview")).toContainText("updated again");
    expect(await recordedActions()).toEqual([]);
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    const menu = first.getByRole("button", { name: "打开菜单 1.txt", exact: true });
    await menu.click();
    await expect(page.getByRole("menuitem")).toHaveText([
      "Finder",
      "使用默认程序打开",
      "复制绝对路径",
      "复制相对路径",
    ]);
    await expect
      .poll(() =>
        page
          .getByRole("menuitem", { name: "Finder", exact: true })
          .locator("img")
          .evaluate((img) => (img as HTMLImageElement).naturalWidth),
      )
      .toBeGreaterThan(0);
    await page.screenshot({ path: "test-results/changed-files-open-menu.png" });
    await page.getByRole("menuitem", { name: "Finder", exact: true }).click();
    await expect.poll(recordedActions).toEqual([{ action: "reveal", path: absolutePath }]);
    await menu.click();
    await expect(
      page.getByRole("menuitem", { name: "使用默认程序打开", exact: true }).locator("svg"),
    ).toBeVisible();
    await page.getByRole("menuitem", { name: "使用默认程序打开", exact: true }).click();
    await expect.poll(recordedActions).toEqual([
      { action: "reveal", path: absolutePath },
      { action: "open", path: absolutePath },
    ]);
    await menu.click();
    await page.getByRole("menuitem", { name: "复制绝对路径", exact: true }).click();
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toBe(absolutePath);
    await menu.click();
    await page.getByRole("menuitem", { name: "复制相对路径", exact: true }).click();
    await expect.poll(() => app?.evaluate(({ clipboard }) => clipboard.readText())).toBe(paths[0]);
    await expect(page.locator(".right-pane")).toBeHidden();
    await app.evaluate(({ shell }) => {
      shell.openPath = async () => "没有可用的默认应用程序";
    });
    await menu.click();
    await page.getByRole("menuitem", { name: "使用默认程序打开", exact: true }).click();
    await expect(card.getByRole("alert")).toContainText("没有可用的默认应用程序");
    await menu.click();
    await page.getByRole("menuitem", { name: "复制相对路径", exact: true }).click();
    await expect(card.getByRole("alert")).toHaveCount(0);
    await card
      .locator(".changed-file-row")
      .nth(1)
      .getByRole("button", { name: "审查 1.txt", exact: true })
      .click();
    await expect(
      page.getByRole("tabpanel", { name: "变更", exact: true }).locator("diffs-container"),
    ).toContainText("original 1");
    await expect(
      page.getByRole("tabpanel", { name: "变更", exact: true }).locator("diffs-container"),
    ).toContainText("updated 1");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(840, 720));
    await expect.poll(() => card.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
    await card.locator(".changed-file-card").last().scrollIntoViewIfNeeded();
    await expect(card.locator(".changed-file-card").last()).toBeInViewport();
    await page.screenshot({ path: "test-results/changed-files-narrow.png" });
    await page.getByLabel("消息", { exact: true }).fill("不修改文件");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("run").last().locator(".changed-files")).toHaveCount(0);
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.locator(".changed-files-list")).toBeHidden();
    await expect(page.locator(".changed-files-totals")).toHaveText("+21-21");
  } finally {
    release.resolve();
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("changed HTML opens in the same built-in browser as conversation links, with explicit default-app opening", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-changed-html-")));
  const project = join(dir, "project");
  await mkdir(project);
  const name = "页面 #1.html";
  const path = join(project, name);
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write-html",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: name, content: "<h1>Built-in preview</h1>" }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: `[页面](<${pathToFileURL(path).href}>)` }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ shell }) => {
      Object.assign(globalThis, { htmlOpenCalls: [] as string[] });
      shell.openPath = async (path) => {
        (globalThis as typeof globalThis & { htmlOpenCalls: string[] }).htmlOpenCalls.push(path);
        return "";
      };
    });
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("create page");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.locator(".changed-files summary").click();
    await page.getByRole("button", { name: `打开 ${name}`, exact: true }).click();
    await expect(page.getByRole("textbox", { name: "浏览器地址", exact: true })).toHaveValue(
      pathToFileURL(path).href,
    );
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await page.locator(".answer").getByRole("button", { name: "页面", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "浏览器地址", exact: true })).toHaveValue(
      pathToFileURL(path).href,
    );
    expect(
      await app.evaluate(() => (globalThis as typeof globalThis & { htmlOpenCalls: string[] }).htmlOpenCalls),
    ).toEqual([]);
    await page.getByRole("button", { name: `打开菜单 ${name}`, exact: true }).click();
    await page.getByRole("menuitem", { name: "使用默认程序打开", exact: true }).click();
    await expect
      .poll(() =>
        app?.evaluate(() => (globalThis as typeof globalThis & { htmlOpenCalls: string[] }).htmlOpenCalls),
      )
      .toEqual([path]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
