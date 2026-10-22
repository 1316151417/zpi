import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("changed files preserve filenames before directories and remain usable in narrow windows", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-changed-file-layout-"));
  const project = join(dir, "project");
  await mkdir(project);
  const directory = "src/main/java/com/ke/home/trusteeship/performance/decision/";
  const paths = [
    `trusteeship-performance-service/${directory}HouseKeeperDecisionService.java`,
    `trusteeship-performance-service/${directory.replace("/main/", "/test/")}RecommendAndShowHouseDecisionServiceTest.java`,
    "trusteeship-performance-web/src/test/java/com/ke/home/trusteeship/performance/AgentRuntimeLiveTest.java",
    `trusteeship-performance-service/${directory}RecommendAndShowHouseDecisionService.java`,
  ];
  const server = await fakeServer((body, response) => {
    const messages = body.messages as { role: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: paths.map((path, index) => ({
            index,
            id: `write-${index}`,
            type: "function",
            function: { name: "write", arguments: JSON.stringify({ path, content: "updated\n" }) },
          })),
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "已修改。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("修改文件");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const card = page.locator(".changed-files");
    await card.locator("summary").click();
    await expect(card.locator(".changed-files-chevron")).toHaveCSS("transform", "matrix(0, 1, -1, 0, 0, 0)");
    const rows = card.locator(".changed-file-row");
    await expect(rows).toHaveCount(4);
    const oldLayout = await page.addStyleTag({ content: ".changed-file-info { display: inline-flex; }" });
    expect(
      await rows
        .first()
        .locator("strong")
        .evaluate((el) => el.scrollWidth - el.clientWidth),
    ).toBeGreaterThan(0);
    await card.screenshot({ path: "test-results/changed-file-layout-before.png" });
    await oldLayout.evaluate((el) => el.parentNode?.removeChild(el));
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      for (const row of await rows.all()) {
        await expect
          .poll(() => row.locator("strong").evaluate((el) => el.scrollWidth - el.clientWidth))
          .toBe(0);
        expect(
          await row.locator(".changed-file-directory").evaluate((el) => el.scrollWidth - el.clientWidth),
        ).toBeGreaterThan(0);
      }
      await card.screenshot({ path: `test-results/changed-file-layout-${scheme}.png` });
    }
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.setSize(840, 720));
    await expect.poll(() => card.evaluate((el) => el.scrollWidth - el.clientWidth)).toBe(0);
    await expect
      .poll(() =>
        rows
          .nth(1)
          .locator("strong")
          .evaluate((el) => el.scrollWidth - el.clientWidth),
      )
      .toBeGreaterThan(0);
    for (const row of await rows.all()) {
      await expect(row.getByRole("button", { name: /^审查 / })).toBeInViewport();
      await expect(row.getByRole("button", { name: /^打开 / })).toBeInViewport();
    }
    await card.screenshot({ path: "test-results/changed-file-layout-narrow.png" });
  } finally {
    await runCleanup([
      () => app?.close(),
      () => server.close(),
      () => rm(dir, { recursive: true, force: true }),
    ]);
  }
});
