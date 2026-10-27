import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { create, select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

const bar = (page: Page) => page.getByRole("dialog", { name: "在任务中查找", exact: true });
const count = (page: Page) => bar(page).getByRole("status");
const highlight = (page: Page, scope = "conversation") =>
  page.evaluate((scope) => {
    const matches = CSS.highlights.get(`zpi-${scope}-find-active`);
    return matches
      ? [...matches].map((range) => ({
          text: range.toString(),
          key: range.startContainer.parentElement?.closest("[data-find-key]")?.getAttribute("data-find-key"),
        }))
      : [];
  }, scope);

test("cold search indexes offscreen history without mounting every rich turn and jumps to its hit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-find-cold-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seed = seedHistory(dir, cwd, 160);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await page.addInitScript(
      (id) =>
        localStorage.setItem(
          `zpi.reading.${id}`,
          JSON.stringify({ following: false, cursor: 0, top: 0, runId: "run-0", offset: 0 }),
        ),
      seed.id,
    );
    await page.reload();
    await expect(page.locator("[data-history-run]")).toHaveCount(160);
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
    await page.evaluate(() => {
      const area = document.querySelector(".conversation");
      if (!area) throw new Error("Missing history viewport");
      let max = 0;
      const count = () => {
        max = Math.max(max, area.querySelectorAll('[data-history-mounted="true"]').length);
      };
      new MutationObserver(count).observe(area, {
        childList: true,
        attributes: true,
        subtree: true,
        attributeFilter: ["data-history-mounted"],
      });
      Object.assign(window, { zpiMaxMountedFindRuns: () => max });
      count();
    });
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const input = bar(page).getByRole("textbox");
    await input.fill("最终回复 117");
    await expect(count(page)).toHaveText("1/1");
    await expect.poll(() => highlight(page)).toEqual([{ text: "最终回复 117", key: "run-117:answer" }]);
    await expect(page.locator('[data-run-id="run-117"] .answer')).toBeInViewport();
    await input.fill("最终回复 0");
    await expect(count(page)).toHaveText("1/1");
    await expect.poll(() => highlight(page)).toEqual([{ text: "最终回复 0", key: "run-0:answer" }]);
    await expect(page.locator('[data-run-id="run-0"] .answer')).toBeInViewport();
    expect(
      await page.evaluate(() =>
        (window as typeof window & { zpiMaxMountedFindRuns(): number }).zpiMaxMountedFindRuns(),
      ),
    ).toBeLessThan(40);
    await input.press("Escape");
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("cached history search avoids rereading stable text during navigation and streaming", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-find-cache-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  seedHistory(dir, cwd, 60);
  const release = deferred();
  const server = await fakeServer(async (_, response) => {
    send(response, chunk({ content: "最终回复 新内容" }));
    await release.promise;
    send(response, chunk({ content: "，最终回复 后续内容" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const input = bar(page).getByRole("textbox");
    await input.fill("最终回复");
    await expect(page.locator("[data-history-run]")).toHaveCount(60);
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
    await expect(count(page)).toHaveText("1/60");
    await page.evaluate(() => {
      const root = document.querySelector(".conversation");
      const old = new Set(
        [...(root?.querySelectorAll<HTMLElement>("[data-find-key]") ?? [])].map(
          (node) => node.dataset.findKey,
        ),
      );
      const reads: string[] = [];
      const walk = document.createTreeWalker.bind(document);
      document.createTreeWalker = (node, ...args) => {
        if (node instanceof HTMLElement && node.dataset.findKey) reads.push(node.dataset.findKey);
        return walk(node, ...args);
      };
      Object.assign(window, {
        zpiFindCacheProbe: () => ({
          stableReads: reads.filter((key) => old.has(key)).length,
          newReads: reads.filter((key) => !old.has(key)).length,
        }),
      });
    });
    const probe = () =>
      page.evaluate(() =>
        (
          window as typeof window & {
            zpiFindCacheProbe(): { stableReads: number; newReads: number };
          }
        ).zpiFindCacheProbe(),
      );
    await input.press("Enter");
    await expect(count(page)).toHaveText("2/60");
    // Navigation can mount a new offscreen turn; only stable mounted text must avoid rereads.
    expect((await probe()).stableReads).toBe(0);
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("继续输出");
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(count(page)).toHaveText("2/61");
    release.resolve();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(count(page)).toHaveText("2/62");
    expect(await probe()).toMatchObject({ stableReads: 0, newReads: expect.any(Number) });
    expect((await probe()).newReads).toBeGreaterThan(0);
    await input.press("Escape");
    await expect.poll(() => highlight(page)).toEqual([]);
    await expect.poll(() => page.getByTestId("run").count()).toBeLessThan(30);
  } finally {
    release.resolve();
    await runCleanup([server.close, () => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("task find matches ZCode layout, shortcuts, wraparound, highlights and focus", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-find-"));
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({
        content: `项目说明\n\nPROJECT 示例。\n\n跨**格式**匹配。\n\n查看[链接文案](https://example.com/private-destination)以及[文件文案](./notes.md)。\n\n[链接**文案**](https://example.org)。\n\n${"正文内容\n\n".repeat(35)}唯一定位词`,
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("请创建项目");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await editor.focus();
    await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const input = bar(page).getByRole("textbox");
    await expect(input).toBeFocused();
    await expect(count(page)).toHaveText("0/0");
    await expect(bar(page).getByRole("button", { name: "下一个结果" })).toBeDisabled();
    await input.fill("项目");
    await expect(count(page)).toHaveText("1/2");
    await expect
      .poll(() => highlight(page))
      .toEqual([{ text: "项目", key: expect.stringContaining(":user") }]);
    await input.press("Enter");
    await expect(count(page)).toHaveText("2/2");
    await input.press("ArrowDown");
    await expect(count(page)).toHaveText("1/2");
    await input.press("Shift+Enter");
    await expect(count(page)).toHaveText("2/2");
    await bar(page).getByRole("button", { name: "上一个结果" }).click();
    await expect(count(page)).toHaveText("1/2");
    await editor.click();
    await expect(bar(page)).toBeVisible();
    await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    await expect(bar(page)).toHaveCount(0);
    await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("");
    await input.fill("项目");
    const geometry = await bar(page).evaluate((element) => {
      const bounds = element.getBoundingClientRect(),
        parent = element.parentElement?.getBoundingClientRect();
      return {
        width: bounds.width,
        height: bounds.height,
        center: bounds.x + bounds.width / 2 - (parent ? parent.x + parent.width / 2 : 0),
        top: bounds.y - (parent?.y ?? 0),
      };
    });
    expect(geometry).toEqual({ width: 360, height: 38, center: 0, top: 12 });
    await page.screenshot({ path: "test-results/task-find-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/task-find-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await input.fill("  project  ");
    await expect(count(page)).toHaveText("1/1");
    await expect.poll(() => highlight(page)).toEqual([{ text: "PROJECT", key: expect.any(String) }]);
    await input.fill("跨格式匹配");
    await expect(count(page)).toHaveText("1/1");
    await expect.poll(() => highlight(page)).toEqual([{ text: "跨格式匹配", key: expect.any(String) }]);
    await input.fill("链接文案");
    await expect(count(page)).toHaveText("1/2");
    await expect.poll(() => highlight(page)).toEqual([{ text: "链接文案", key: expect.any(String) }]);
    await input.press("Enter");
    await expect(count(page)).toHaveText("2/2");
    await expect.poll(() => highlight(page)).toEqual([{ text: "链接文案", key: expect.any(String) }]);
    await input.press("Enter");
    await expect(count(page)).toHaveText("1/2");
    for (const query of ["文件文案", "查看链接文案以及文件文案。"]) {
      await input.fill(query);
      await expect(count(page)).toHaveText("1/1");
      await expect.poll(() => highlight(page)).toEqual([{ text: query, key: expect.any(String) }]);
    }
    for (const query of ["private-destination", "复制", "重新生成"]) {
      await input.fill(query);
      await expect(count(page)).toHaveText("0/0");
    }
    await input.fill("示例。跨");
    await expect(count(page)).toHaveText("0/0");
    await input.fill("唯一定位词");
    await expect(count(page)).toHaveText("1/1");
    await expect.poll(() => highlight(page)).toEqual([{ text: "唯一定位词", key: expect.any(String) }]);
    await page.locator(".conversation").evaluate((element) => {
      element.scrollTop = 0;
    });
    await input.press("Enter");
    await expect
      .poll(() => page.locator(".conversation").evaluate((element) => element.scrollTop))
      .toBeGreaterThan(100);
    await input.fill("不存在的关键词");
    await expect(count(page)).toHaveText("0/0");
    await input.press("Enter");
    await expect(count(page)).toHaveText("0/0");
    await input.press("Escape");
    await expect(bar(page)).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect.poll(() => highlight(page)).toEqual([]);
    await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    await expect(bar(page).getByRole("textbox")).toHaveValue("");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(840, 720));
    await expect
      .poll(() => bar(page).evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBe(0);
    await create(page);
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("search loads older history, preserves the active message and ignores tools and reasoning", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-find-history-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seed = seedHistory(dir, cwd, 30);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "reply" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await expect(page.getByTestId("run")).toHaveCount(10);
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const input = bar(page).getByRole("textbox");
    await input.fill("最终回复 0");
    await expect(page.getByTestId("run")).toHaveCount(30);
    await expect(count(page)).toHaveText("1/1");
    await expect.poll(() => highlight(page)).toEqual([{ text: "最终回复 0", key: "run-0:answer" }]);
    await expect(page.locator('[data-run-id="run-0"] .answer').first()).toBeInViewport();
    await input.fill("工具结果");
    await expect(count(page)).toHaveText("0/0");
    await input.fill("思考");
    await expect(count(page)).toHaveText("0/0");
    await input.fill("最终回复");
    await expect(count(page)).toHaveText("1/30");
    await input.press("ArrowUp");
    await expect(count(page)).toHaveText("30/30");
    await create(page);
    await expect(bar(page)).toHaveCount(0);
    await select(page, seed.id);
    await expect.poll(() => highlight(page)).toEqual([]);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("file scope searches lazy patches across files, highlights split diffs and Escape closes find before stopping", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-find-changes-")),
    project = join(dir, "project");
  await mkdir(project);
  await Promise.all(["a.txt", "b.txt"].map((path) => writeFile(join(project, path), "old needle\n")));
  await writeFile(
    join(project, "large.txt"),
    Array.from({ length: 2200 }, (_, index) => `before ${index}\n`).join(""),
  );
  const release = deferred();
  const server = await fakeServer(async (body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    if (messages.filter((message) => message.role === "user").length > 1) {
      send(response, chunk({ content: "流式 needle" }));
      await release.promise;
      done(response);
    } else if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          content: "过程中 **needle**",
          tool_calls: ["a.txt", "b.txt", "large.txt"].map((path, index) => ({
            index,
            id: `write-${index}`,
            type: "function",
            function: {
              name: "write",
              arguments: JSON.stringify({
                path,
                content:
                  path === "large.txt"
                    ? Array.from(
                        { length: 2200 },
                        (_, line) => `after ${line}${line === 2150 ? " 远端命中" : ""}\n`,
                      ).join("")
                    : "new needle\n",
              }),
            },
          })),
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "完成修改 needle" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, project });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("更新两个文件");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    let input = bar(page).getByRole("textbox");
    await input.fill("needle");
    await expect(count(page)).toHaveText("1/2");
    await expect(page.getByTestId("process")).toBeVisible();
    const progress = page.getByTestId("progress");
    await progress.click();
    await expect(progress).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("process")).toHaveCount(0);
    await expect(count(page)).toHaveText("1/2");
    await expect.poll(() => highlight(page)).toEqual([]);
    await input.press("Enter");
    await expect(count(page)).toHaveText("2/2");
    await expect(progress).toHaveAttribute("aria-expanded", "false");
    await input.press("Enter");
    await expect(count(page)).toHaveText("1/2");
    await expect(progress).toHaveAttribute("aria-expanded", "true");
    await expect.poll(() => highlight(page).then((hits) => hits.map((hit) => hit.text))).toEqual(["needle"]);
    await input.fill("过程中 needle");
    await expect(count(page)).toHaveText("1/1");
    await progress.click();
    await expect(progress).toHaveAttribute("aria-expanded", "false");
    await expect(count(page)).toHaveText("1/1");
    await input.press("Enter");
    await expect(progress).toHaveAttribute("aria-expanded", "true");
    await input.fill("needle");
    await expect(count(page)).toHaveText("1/2");
    await bar(page).getByRole("button", { name: "搜索文件变更", exact: true }).click();
    input = bar(page).getByRole("textbox");
    await expect(input).toHaveAttribute("placeholder", "搜索文件变更...");
    await expect(count(page)).toHaveText("1/4");
    await expect.poll(() => highlight(page)).toEqual([]);
    await expect
      .poll(() => highlight(page, "changes").then((values) => values.map((value) => value.text)))
      .toEqual(["needle"]);
    await input.press("Enter");
    await expect(count(page)).toHaveText("2/4");
    await input.press("Enter");
    await expect(count(page)).toHaveText("3/4");
    await expect(page.locator(".changes-pane .preview-path-file > strong")).toHaveText("b.txt");
    await expect(page.getByRole("button", { name: "并排", exact: true })).toHaveCount(0);
    await expect
      .poll(() => highlight(page, "changes").then((values) => values.map((value) => value.text)))
      .toEqual(["needle"]);
    await page.screenshot({ path: "test-results/task-find-changes.png" });
    await input.fill("远端命中");
    await expect(count(page)).toHaveText("1/1");
    await expect(page.locator(".changes-pane .preview-path-file > strong")).toHaveText("large.txt");
    await expect
      .poll(() => highlight(page, "changes").then((values) => values.map((value) => value.text)))
      .toEqual(["远端命中"]);
    expect(await page.locator(".diff-plain .diff-row").count()).toBeLessThanOrEqual(2000);
    await input.press("Enter");
    await expect(count(page)).toHaveText("1/1");
    await input.fill("needle");
    await expect(count(page)).toHaveText("1/4");
    await bar(page).getByRole("button", { name: "搜索消息", exact: true }).click();
    await expect(count(page)).toHaveText("1/2");
    await expect.poll(() => highlight(page, "changes")).toEqual([]);
    await input.press("Escape");
    await editor.fill("继续工作");
    await editor.press("Enter");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    input = bar(page).getByRole("textbox");
    await input.fill("needle");
    await expect(count(page)).toHaveText("1/3");
    await input.dispatchEvent("compositionstart", { data: "zhong" });
    await input.press("Escape");
    await expect(bar(page)).toBeVisible();
    await input.dispatchEvent("compositionend", { data: "" });
    await input.press("Escape");
    await expect(bar(page)).toHaveCount(0);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    release.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
