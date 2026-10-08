import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("folder mentions share ZCode file search, parent paths, icons, keyboard scrolling and draft restoration", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-mention-folders-"));
  const cwd = join(dir, "workspace");
  const folder = join(cwd, "skills", "know-base-update");
  await mkdir(join(folder, "references"), { recursive: true });
  const folderPath = await realpath(folder);
  await writeFile(join(folder, "SKILL.md"), "Skill contents");
  await Promise.all(
    Array.from({ length: 40 }, (_, i) =>
      writeFile(join(cwd, `update-${i.toString().padStart(2, "0")}.py`), ""),
    ),
  );
  const id = seedHistory(dir, cwd, 1).id;
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "Folder received" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await select(page, id);
    let editor = page.getByLabel("消息", { exact: true });
    const panel = page.getByRole("listbox", { name: "引用文件" });
    for (const prefix of ["帮我看看", "参考：", "看看，", "\n"]) {
      await editor.fill(prefix);
      await editor.press("End");
      await editor.press("@");
      await expect(panel).toBeVisible();
      await editor.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(editor).toHaveText(`${prefix}@`);
    }
    for (const text of ["name@example.com", "联系邮箱@example.com", "用户@例子.公司"]) {
      await editor.fill(text);
      await expect(panel).toHaveCount(0);
    }
    await editor.fill("帮我看看@know-base-update");
    await expect(panel.getByRole("option", { name: "know-base-update skills/", exact: true })).toBeVisible();
    await editor.press("Tab");
    await expect(editor).toHaveText("帮我看看know-base-update ");
    await expect(editor.locator(".inline-mention.file")).toHaveText("know-base-update");
    await editor.fill("@update");
    await expect(panel.getByRole("option")).toHaveCount(43);
    await expect(panel.locator("h3")).toHaveCount(0);
    const option = panel.getByRole("option", { name: "know-base-update skills/", exact: true });
    await expect(option.locator("img")).toHaveAttribute("src", /material-icons\/folder\.svg$/);
    await expect(option.locator("span")).toHaveText("skills/");
    const dock = await page.locator(".composer").boundingBox();
    for (let i = 0; i < 40; i++) await editor.press("ArrowDown");
    await expect(option).toHaveAttribute("aria-selected", "true");
    await expect(option).toBeInViewport();
    expect(await panel.locator(".command-options").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator(".composer").boundingBox()).toEqual(dock);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await page.screenshot({ path: `test-results/folder-mentions-${colorScheme}.png` });
    }
    await editor.press("Tab");
    const chip = editor.locator(".inline-mention.file");
    await expect(chip).toHaveText("know-base-update");
    await expect(chip).toHaveAttribute("data-markdown", /know-base-update\/\)$/);
    await expect(chip).toHaveCSS("--mention-image", /folder\.svg/);
    await expect
      .poll(async () => {
        const draft = await page.evaluate((id) => window.ZPI.getDraft(id), id);
        return draft.ok ? draft.value.text : "";
      })
      .toBe(`[know-base-update](${folderPath}/) `);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    editor = page.getByLabel("消息", { exact: true });
    await expect(editor.locator(".inline-mention.file")).toHaveText("know-base-update");
    await expect(page.locator(".draft-warning")).toHaveCount(0);
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(1);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[0])).toContain(`${folderPath}/`);
    await expect(page.locator(".user-message-text .inline-mention.file").last()).toHaveCSS(
      "--mention-image",
      /folder\.svg/,
    );
    await editor.fill("@kbupd");
    await expect(page.getByRole("option", { name: "know-base-update skills/", exact: true })).toBeVisible();
    await editor.press("Escape");
    await expect(page.getByRole("listbox", { name: "引用文件" })).toHaveCount(0);
    await expect(editor).toHaveText("@kbupd");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
