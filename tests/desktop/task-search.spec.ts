import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

const search = (page: Page) => page.getByRole("dialog", { name: "搜索任务", exact: true });
const input = (page: Page) => search(page).getByRole("combobox");

test("sidebar search matches ZCode scopes, keyboard navigation, history, geometry and old-message jumps", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-search-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const older = seedHistory(dir, cwd, 30);
  const recent = seedHistory(dir, cwd, 1);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await expect(page.locator(".sidebar")).toBeVisible();
    await page.evaluate(
      async ({ older, recent }) => {
        await window.zpi.renameSession(older, "Old searchable task");
        await window.zpi.renameSession(recent, "Recent task");
      },
      { older: older.id, recent: recent.id },
    );
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await expect(input(page)).toBeFocused();
    await expect(search(page).getByRole("tab")).toHaveText(["全部", "操作", "任务", "文件"]);
    await expect(search(page).getByRole("tab", { name: "全部", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    const geometry = () =>
      search(page).evaluate((element) => {
        const rect = element.getBoundingClientRect();
        const input = element.querySelector(".task-search-input-wrap")?.getBoundingClientRect();
        const tab = element.querySelector('[role="tab"]')?.getBoundingClientRect();
        return {
          width: rect.width,
          top: rect.top,
          radius: getComputedStyle(element).borderRadius,
          input: input?.height,
          tab: tab?.height,
        };
      });
    await expect.poll(geometry).toEqual({ width: 512, top: 80, radius: "16px", input: 32, tab: 24 });
    await input(page).fill("#SEARCHABLE");
    await expect(search(page).getByRole("tab", { name: "任务", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(search(page).getByRole("option")).toHaveCount(1);
    await expect(search(page).locator("mark").first()).toHaveText("searchable");
    await input(page).press("Escape");
    await expect(search(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "搜索", exact: true })).toBeFocused();
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+f`);
    await input(page).fill("#最终回复 0");
    await expect(search(page).getByRole("option")).toHaveCount(2);
    await page.screenshot({ path: "test-results/task-search-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(search(page).locator(".task-search-input-wrap")).toHaveCSS(
      "background-color",
      "rgb(10, 10, 10)",
    );
    await page.screenshot({ path: "test-results/task-search-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await search(page).getByRole("option").filter({ hasText: "Old searchable task" }).click();
    await expect(search(page)).toHaveCount(0);
    await expect(page.getByRole("dialog", { name: "在任务中查找" })).toBeVisible();
    await expect(page.getByRole("dialog", { name: "在任务中查找" }).getByRole("textbox")).toBeFocused();
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...(CSS.highlights.get("zpi-conversation-find-active") ?? [])].map((range) => range.toString()),
        ),
      )
      .toEqual(["最终回复 0"]);
    await expect(page.getByTestId("run").first()).toHaveAttribute("data-run-id", "run-0");
    await page.keyboard.press("Escape");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+f`);
    await expect(input(page)).toHaveValue("");
    await expect(search(page).getByText("搜索历史", { exact: true })).toBeVisible();
    await search(page)
      .getByRole("button", { name: /最终回复 0/ })
      .click();
    await expect(input(page)).toHaveValue("#最终回复 0");
    await input(page).fill("#missing result");
    await expect(search(page).getByText("暂无相关结果")).toBeVisible();
    await input(page).fill("");
    await search(page).getByRole("button", { name: "清除搜索历史" }).click();
    await expect(search(page).getByText("搜索历史", { exact: true })).toHaveCount(0);
    await input(page).fill(">设置");
    await expect(search(page).getByRole("option")).toHaveCount(1);
    await input(page).press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+f`);
    await expect(input(page)).toBeFocused();
    await input(page).press("Enter");
    await expect(search(page)).toHaveCount(0);
    await expect(page.locator(".settings-screen")).toBeVisible();
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});

test("task search previews three results, expands, searches workspace files and dismisses safely during IME", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-search-files-")),
    cwd = join(dir, "workspace");
  await mkdir(cwd);
  const seeds = Array.from({ length: 6 }, () => seedHistory(dir, cwd, 1));
  await Promise.all(
    Array.from({ length: 25 }, (_, i) =>
      writeFile(join(cwd, `example-${i}.ts`), `export const value = ${i};`),
    ),
  );
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: "" });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "搜索", exact: true }).click();
    await input(page).fill("历史标题");
    await expect(search(page).getByRole("option")).toHaveCount(3);
    await search(page).getByRole("button", { name: "查看更多结果" }).click();
    await expect(search(page).getByRole("option")).toHaveCount(6);
    await page.evaluate((id) => window.zpi.renameSession(id, "实时任务"), seeds[0].id);
    await expect(search(page).getByRole("option")).toHaveCount(5);
    await search(page).getByRole("tab", { name: "任务", exact: true }).click();
    await expect(input(page)).toBeFocused();
    await expect(search(page).getByRole("option")).toHaveCount(5);
    await input(page).fill("#实时任务");
    await expect(search(page).getByRole("option")).toHaveCount(1);
    await input(page).fill("@example-24");
    await expect(search(page).getByRole("tab", { name: "文件", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(search(page).getByRole("option")).toHaveCount(1);
    await input(page).press("Enter");
    await expect(search(page)).toHaveCount(0);
    await expect(page.locator(".pane-tabs")).toContainText("example-24.ts");
    await page.keyboard.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Shift+f`);
    await input(page).fill("#历史标题");
    const chosen = await search(page).locator('[data-selected="true"]').getAttribute("data-value");
    await input(page).press("ArrowUp");
    expect(await search(page).locator('[data-selected="true"]').getAttribute("data-value")).not.toBe(chosen);
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(840, 720));
    await expect
      .poll(() => search(page).evaluate((element) => element.scrollWidth - element.clientWidth))
      .toBe(0);
    await input(page).dispatchEvent("keydown", { key: "Escape", isComposing: true });
    await expect(search(page)).toBeVisible();
    await input(page).press("Escape");
    await expect(search(page)).toHaveCount(0);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await runCleanup([() => rm(dir, { recursive: true, force: true }), () => app?.close()]);
  }
});
