import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "../../packages/desktop/src/main/workspace-files.ts";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("review matches source menu, compact collapsible rows, find, context actions and last-turn state", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-review-")));
  const project = join(dir, "project");
  await mkdir(project);
  await runGit(project, ["init", "-b", "main"]);
  await runGit(project, ["config", "user.name", "Review Test"]);
  await runGit(project, ["config", "user.email", "review@example.invalid"]);
  await writeFile(join(project, "example.txt"), "original\n");
  await runGit(project, ["add", "."]);
  await runGit(project, ["commit", "-m", "Initial"]);
  await writeFile(join(project, "example.txt"), "staged\n");
  await runGit(project, ["add", "."]);
  await writeFile(join(project, "example.txt"), "working\n");
  await writeFile(join(project, "new.txt"), "new content searchable\n");
  const server = await fakeServer((_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "notes",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({
                  path: "notes.md",
                  content: "# Review notes\n\nSnapshot content.\n",
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "完成。" }));
      done(response);
    }
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1440, 900));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("write notes");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByRole("button", { name: "展开右侧栏", exact: true }).click();
    await page.locator('[data-side-pane-open-tab-item="review"]:visible').click();
    const pane = page.locator(".review-pane:visible");
    const source = pane.getByRole("combobox", { name: "审查来源" });
    await expect(source).toHaveText("未暂存");
    await expect(pane.locator(".review-file-row")).toHaveCount(3);
    await expect(pane.locator(".diff-file-list, .preview-header, .diff-mode, .diff-heading")).toHaveCount(0);
    await source.click();
    await expect(page.getByRole("option")).toHaveText(["未暂存", "已暂存", "全部分支更改", "上一轮更改"]);
    await page.getByRole("option", { name: "已暂存", exact: true }).click();
    await expect(pane.locator(".review-file-row")).toHaveCount(1);
    await pane.locator(".review-file-row").click();
    await expect(pane.locator("diffs-container")).toBeVisible();
    await expect(pane.locator(".review-file-row")).toHaveAttribute("aria-expanded", "true");
    const firstPatch = await page.evaluate(async () => {
      const sessions = await window.zpi.listRecentSessions();
      if (!sessions.ok) throw new Error(sessions.error.message);
      const review = await window.zpi.getReview(sessions.value[0].id, "staged");
      if (!review.ok) throw new Error(review.error.message);
      return window.zpi.readReviewDiff(sessions.value[0].id, "staged", review.value.entries[0].path);
    });
    expect(firstPatch.ok && firstPatch.value.patch).toContain("-original\n+staged");
    await source.click();
    await page.getByRole("option", { name: "未暂存", exact: true }).click();
    await expect(pane.locator(".review-file-row")).toHaveCount(3);
    const notes = pane.getByRole("button", { name: /notes\.md/ });
    await notes.click();
    await expect(pane.locator(".review-change-content")).toContainText("Snapshot content.");
    await pane.getByRole("button", { name: /new\.txt/ }).click();
    await expect(notes).toHaveAttribute("aria-expanded", "false");
    await expect(pane.locator(".review-change-content")).toContainText("new content searchable");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+f`);
    const find = page.getByRole("dialog", { name: "在任务中查找", exact: true });
    await find.getByRole("button", { name: "搜索文件变更", exact: true }).click();
    await find.getByRole("textbox").fill("Snapshot content.");
    await expect(pane.locator('.review-file-row[aria-expanded="true"]')).toContainText("notes.md");
    await expect(pane.locator(".review-change-content")).toContainText("Snapshot content.");
    await find.getByRole("textbox").press("Escape");
    const evidence = process.env.ZPI_REVIEW_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await pane.screenshot({ path: join(evidence, "file-expanded-light.png") });
      const size = await notes.boundingBox();
      expect(size?.height).toBe(32);
    }
    await notes.click({ button: "right" });
    await expect(page.getByRole("menuitem")).toHaveText([
      "在 Finder 中打开",
      "复制绝对路径",
      "复制相对路径",
      "在文件树中显示",
    ]);
    await page.getByRole("menuitem", { name: "在文件树中显示", exact: true }).click();
    await expect(page.locator('.file-tree-row[aria-selected="true"]')).toContainText("notes.md");
    await page.getByRole("tab", { name: "审查", exact: true }).click();
    await source.click();
    await page.getByRole("option", { name: "上一轮更改", exact: true }).click();
    await expect(pane.locator(".review-file-row")).toHaveCount(1);
    await expect(pane.locator(".review-file-row")).toContainText("notes.md");
    await pane.locator(".review-file-row").click();
    await expect(pane.locator(".review-change-content")).toContainText("Snapshot content.");
    await writeFile(join(project, "notes.md"), "changed outside the agent\n");
    await pane.getByRole("button", { name: "刷新", exact: true }).click();
    await expect(pane.locator(".review-change-content")).toContainText("Snapshot content.");
    await page.getByLabel("消息", { exact: true }).fill("read-only followup");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(pane.locator(".review-empty")).toContainText("当前任务还没有上一轮文件改动");
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await pane.screenshot({ path: join(evidence, "last-turn-empty-light.png") });
      await source.click();
      await page.screenshot({ path: join(evidence, "source-menu-light.png") });
      await page.keyboard.press("Escape");
      await page.evaluate(() => {
        document.documentElement.dataset.theme = "dark";
        document.documentElement.style.colorScheme = "dark";
      });
      await pane.screenshot({ path: join(evidence, "last-turn-empty-dark.png") });
    }
    await Promise.all(
      Array.from({ length: 160 }, (_, index) =>
        writeFile(join(project, `zz-${String(index).padStart(3, "0")}.txt`), `long list row ${index}\n`),
      ),
    );
    await source.click();
    await page.getByRole("option", { name: "未暂存", exact: true }).click();
    await expect(pane.locator(".review-file-row").first()).toBeVisible();
    expect(await pane.locator(".review-file-row").count()).toBeLessThan(90);
    await pane.locator(".review-change-list").evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const last = pane.getByRole("button", { name: /zz-159\.txt/ });
    await expect(last).toBeVisible();
    await last.click();
    await expect(pane.locator(".review-change-content")).toContainText("long list row 159");
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});

test("modified Java review retains ZCode's real expandable leading, middle and trailing unchanged regions", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-review-context-")));
  const project = join(dir, "project");
  const parent =
    "trustedship-performance-service/src/main/java/com/ke/home/trusteeship/performance/service/housekeeper";
  await mkdir(join(project, parent), { recursive: true });
  const file = join(project, parent, "ResetTest.java");
  const original = `${Array.from(
    { length: 120 },
    (_, i) => `import com.ke.home.performance.Line${String(i + 1).padStart(3, "0")};`,
  ).join("\n")}\n`;
  await writeFile(file, original);
  await runGit(project, ["init", "-b", "main"]);
  await runGit(project, ["config", "user.name", "Review Test"]);
  await runGit(project, ["config", "user.email", "review@example.invalid"]);
  await runGit(project, ["add", "."]);
  await runGit(project, ["commit", "-m", "Initial"]);
  await writeFile(
    file,
    original
      .replace("Line019", "Changed019")
      .replace("Line041", "Changed041")
      .replace("Line063", "Changed063"),
  );
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ready" }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>> | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1512, 893));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("review context");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByRole("button", { name: "展开右侧栏", exact: true }).click();
    await page.locator('[data-side-pane-open-tab-item="review"]:visible').click();
    const pane = page.locator(".review-pane:visible");
    await pane.getByRole("button", { name: /ResetTest\.java/ }).click();
    const viewer = pane.locator("diffs-container");
    await expect(viewer.locator("[data-unmodified-lines]").first()).toHaveText("14 unmodified lines");
    await expect(viewer.locator("[data-unmodified-lines]").nth(1)).toHaveText("13 unmodified lines");
    await expect(viewer.locator("[data-unmodified-lines]").nth(2)).toHaveText("13 unmodified lines");
    await expect(pane.locator(".review-lightweight")).toHaveCount(0);
    const line = (text: string) => viewer.locator("[data-code] [data-line]").filter({ hasText: text });
    await expect(line("Line001;")).toHaveCount(0);
    await expect(line("Line030;")).toHaveCount(0);
    await expect(line("Line120;")).toHaveCount(0);
    const evidence = process.env.ZPI_REVIEW_EVIDENCE_DIR;
    if (evidence) {
      await mkdir(evidence, { recursive: true });
      await pane.screenshot({ path: join(evidence, "context-folded-light.png") });
    }
    await viewer.locator("[data-separator-first] [data-expand-button]").first().click();
    await expect(line("Line001;")).toBeVisible();
    await viewer.locator("[data-expand-both]").first().click();
    await expect(line("Line030;")).toBeVisible();
    await viewer.locator("[data-separator-last] [data-expand-button]").first().click();
    await expect(line("Line120;")).toBeAttached();
    const row = pane.locator(".review-file-row");
    const content = pane.locator(".review-change-content");
    await page.mouse.move(0, 0);
    for (const theme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: theme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await pane.locator(".review-change-list").evaluate((element) => {
        element.scrollTop = 500;
      });
      await expect
        .poll(() =>
          pane.evaluate((element) => {
            const list = element.querySelector(".review-change-list")?.getBoundingClientRect();
            const header = element.querySelector(".review-file-row")?.getBoundingClientRect();
            return header && list ? header.top - list.top : null;
          }),
        )
        .toBe(0);
      // The code actually passes behind the sticky title; hiding it must not change any title pixels.
      const title = await row.boundingBox();
      if (!title) throw new Error("Missing sticky review title");
      expect(
        await viewer.locator("[data-code] [data-line]").evaluateAll(
          (lines, top) =>
            lines.some((line) => {
              const bounds = line.getBoundingClientRect();
              return bounds.top < top + 32 && bounds.bottom > top;
            }),
          title.y,
        ),
      ).toBe(true);
      const visibleCode = await row.screenshot({ animations: "disabled" });
      await content.evaluate((element) => {
        element.style.visibility = "hidden";
      });
      const hiddenCode = await row.screenshot({ animations: "disabled" });
      await content.evaluate((element) => {
        element.style.visibility = "";
      });
      expect(visibleCode.equals(hiddenCode), `${theme} sticky title must fully obscure code`).toBe(true);
      if (evidence) await pane.screenshot({ path: join(evidence, `context-expanded-${theme}.png`) });
    }
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
