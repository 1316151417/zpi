import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Page } from "@playwright/test";
import { piTemplate, SessionManager } from "zpi-coding-agent";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { clipboardText } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

async function select(page: Page, id: string) {
  await page.locator(`.session-row[data-session-id="${id}"] .session-name`).first().click();
}

test("hash references search across workspaces, preserve surrounding text, undo atomically and restore draft/sent chips", async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-session-mentions-"));
  const a = join(dir, "a"),
    b = join(dir, "b");
  await mkdir(a);
  await mkdir(b);
  await writeFile(
    join(dir, "projects.json"),
    JSON.stringify([
      { id: "project-a", name: "a", path: a, updatedAt: Date.now() },
      { id: "project-b", name: "b", path: b, updatedAt: Date.now() },
    ]),
  );
  const seeds = [
    seedHistory(dir, a, 1, { projectId: "project-a" }),
    seedHistory(dir, a, 1, { projectId: "project-a" }),
    seedHistory(dir, b, 1, { projectId: "project-b" }),
  ];
  for (const seed of seeds)
    SessionManager.open(seed.file).appendCustomEntry("zpi.configuration", {
      template: { ...piTemplate },
      disabledSkillPaths: [],
      askUserQuestion: true,
      toolBatching: true,
      fileLinks: true,
    });
  const [current, local, other] = seeds.map((seed) => seed.id);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "reply" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await select(page, current);
    await page.evaluate(
      async ({ local, other }) => {
        const localResult = await window.zpi.renameSession(local, "本项目历史");
        const otherResult = await window.zpi.renameSession(other, "跨项目历史");
        if (!localResult.ok || !otherResult.ok) throw new Error(JSON.stringify({ localResult, otherResult }));
      },
      { local, other },
    );
    let editor = page.getByLabel("消息", { exact: true });
    await expect(editor).toHaveAttribute("data-placeholder", "提出后续修改要求");
    await editor.fill("");
    await editor.pressSequentially("#");
    const panel = page.getByRole("listbox", { name: "会话", exact: true });
    await expect(panel.getByRole("option")).toHaveCount(2);
    await expect(panel.getByRole("option").first()).toHaveText("本项目历史a");
    await editor.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(editor).toHaveText("#");
    await editor.fill("");
    await editor.pressSequentially("#跨");
    await expect(panel.getByRole("option")).toHaveCount(1);
    await expect(panel.getByRole("option").first()).toHaveText("跨项目历史b");
    await editor.press("Escape");
    await editor.fill("前 尾");
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Node, 2);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await editor.pressSequentially("#");
    await expect(panel.getByRole("option")).toHaveCount(2);
    await editor.press("ArrowDown");
    await expect(panel.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
    await editor.press("Tab");
    await expect(panel).toHaveCount(0);
    await expect(editor).toHaveText("前 跨项目历史 尾");
    const canonical = `前 [#跨项目历史](#${other}) 尾`;
    await expect(editor.locator(".inline-mention.session")).toHaveAttribute(
      "data-markdown",
      `[#跨项目历史](#${other})`,
    );
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe(canonical);
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.setStartAfter(el.querySelector(".inline-mention.session") as Node);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await editor.press("Backspace");
    await expect(editor.locator(".inline-mention.session")).toHaveCount(0);
    await editor.press("Meta+Z");
    await expect(editor).toHaveText("前 跨项目历史 尾");
    await select(page, other);
    await select(page, current);
    await expect(editor.locator(".inline-mention.session")).toHaveCount(1);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await select(page, current);
    editor = page.getByLabel("消息", { exact: true });
    await expect(editor).toHaveText("前 跨项目历史 尾");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe(canonical);
    await editor.press("ArrowRight");
    await editor.press("Enter");
    const sent = page.locator(".user-message-text").last();
    await expect(sent.locator(".inline-mention.session")).toHaveText("跨项目历史");
    await expect(sent).not.toContainText("Referenced session context:");
    await expect
      .poll(() =>
        page.evaluate(async (id) => {
          const result = await window.zpi.getSessionSnapshot(id);
          return result.ok ? result.value.view.runs.at(-1)?.status : undefined;
        }, current),
      )
      .toBe("completed");
    const result = await page.evaluate((id) => window.zpi.getSessionSnapshot(id), current);
    expect(result.ok && result.value.view.runs.at(-1)?.fileReferences).toEqual([]);
    expect(result.ok && result.value.view.runs.at(-1)?.userMessage).toBe(canonical);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
