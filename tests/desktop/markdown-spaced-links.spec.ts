import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("spaced Markdown file links open the actual file in chat, previews and the default app", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-spaced-links-"));
  const project = join(dir, "project");
  await mkdir(join(project, "doc"), { recursive: true });
  const filename = "【8.20】20261104 北京高端盘-资管&经纪人业绩规则(终稿).md";
  const path = join(project, "doc", filename);
  const encodedName = "订单 %20 汇总.json";
  const encodedPath = join(project, "doc", encodedName);
  await writeFile(path, "# 文件已正确打开\n\n完整路径包含中文、空格、& 和括号。\n");
  await writeFile(encodedPath, '{"sentinel":"字面百分号文件已打开"}');
  await writeFile(join(project, "doc", "index.md"), `[文档内相对链接](./${filename})`);
  const model = await fakeServer(async (_, response) => {
    send(
      response,
      chunk({
        content: `[绝对路径](${path})\n\n[相对路径](./doc/${filename})\n\n[编码路径](./doc/${encodedName.replaceAll("%", "%25")})\n\n[索引](./doc/index.md)`,
      }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: model.url });
    await app.evaluate(({ shell }) => {
      const paths: string[] = [];
      Object.assign(globalThis, { spacedLinkOpenedPaths: paths });
      shell.openPath = async (path) => {
        paths.push(path);
        return "";
      };
    });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.evaluate(async () => {
      const projects = await window.zpi.listProjects();
      if (!projects.ok) throw new Error(projects.error.message);
      const session = await window.zpi.createSession(projects.value[0].id);
      if (!session.ok) throw new Error(session.error.message);
      const run = await window.zpi.startRun({ sessionId: session.value.id, text: "打开带空格的文件链接" });
      if (!run.ok) throw new Error(run.error.message);
      localStorage.setItem("zpi.selectedSession", session.value.id);
    });
    await page.reload();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const answer = page.getByTestId("run").last().locator(".answer");
    for (const label of ["绝对路径", "相对路径"]) {
      await answer.getByRole("button", { name: label, exact: true }).click();
      await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveCount(1);
      await expect(page.locator(".file-markdown-preview:visible")).toContainText("文件已正确打开");
      await expect(page.locator(".notice-window")).toHaveCount(0);
    }
    await answer.getByRole("button", { name: "编码路径", exact: true }).click();
    await expect(page.getByRole("tab", { name: encodedName, exact: true })).toBeVisible();
    await expect(page.locator(".file-text-preview:visible")).toContainText("字面百分号文件已打开");
    await answer.getByRole("button", { name: "索引", exact: true }).click();
    await page
      .locator(".file-markdown-preview:visible")
      .getByRole("button", { name: "文档内相对链接", exact: true })
      .click();
    await expect(page.locator(".file-markdown-preview:visible")).toContainText("文件已正确打开");
    await answer
      .getByRole("button", { name: "相对路径", exact: true })
      .dispatchEvent("click", { metaKey: true });
    await expect
      .poll(() =>
        app?.evaluate(
          () => (globalThis as typeof globalThis & { spacedLinkOpenedPaths: string[] }).spacedLinkOpenedPaths,
        ),
      )
      .toEqual([await realpath(path)]);
    await expect(page.locator(".notice-window")).toHaveCount(0);
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => model.close(),
      () => app?.close(),
    ]);
  }
});
