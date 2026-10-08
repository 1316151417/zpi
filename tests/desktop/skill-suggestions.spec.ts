import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { done, fakeServer } from "../fake-server.ts";
import { select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("skills preserve names beside long descriptions and match ZCode icons, search and insertion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-skill-suggestions-"));
  const cwd = join(dir, "workspace");
  const root = join(cwd, ".agents", "skills");
  const names = ["grill-with-docs", "ke-db", ...Array.from({ length: 12 }, (_, i) => `review-${i}`)];
  for (const name of names) {
    await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name === "ke-db" ? "线上 MySQL 只读查库。" : "Review sources. "}${"Long skill description. ".repeat(30)}\n---\nSkill body`,
    );
  }
  // Project skills already override same-name user skills in the catalog.
  await mkdir(join(dir, "resources", "skills", "ke-db"), { recursive: true });
  await writeFile(
    join(dir, "resources", "skills", "ke-db", "SKILL.md"),
    "---\ndescription: User version\n---\nUser body",
  );
  const id = seedHistory(dir, cwd, 1).id;
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await select(page, id);
    let editor = page.getByLabel("消息", { exact: true });
    await editor.fill("$");
    let panel = page.getByRole("listbox", { name: "技能", exact: true });
    await expect(panel.getByRole("option")).toHaveCount(names.length);
    expect((await panel.locator("strong").allTextContents()).sort()).toEqual([...names].sort());
    await expect(page.locator(".command-hint")).toHaveText("输入内容以搜索技能");
    const option = panel.getByRole("option", { name: /^ke-db 工作区 · 线上 MySQL/ });
    await expect(option.locator("svg")).toHaveClass(/lucide-wand-sparkles/);
    await expect(option.locator("svg")).toHaveAttribute("width", "14");
    await expect(option.locator("svg")).toHaveAttribute("stroke-width", "1.5");
    for (const width of [1200, 820]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: 850 });
      }, width);
      for (const theme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme: theme });
        const layout = await option.evaluate((el) => {
          const name = el.querySelector("strong") as HTMLElement;
          const description = el.querySelector("span") as HTMLElement;
          const icon = el.querySelector("svg") as SVGElement;
          return {
            nameWidth: name.clientWidth,
            nameContent: name.scrollWidth,
            descriptionWidth: description.clientWidth,
            descriptionContent: description.scrollWidth,
            color: getComputedStyle(icon).color,
            nameColor: getComputedStyle(name).color,
            iconHeight: icon.getBoundingClientRect().height,
          };
        });
        expect(layout.nameWidth).toBeGreaterThanOrEqual(layout.nameContent);
        expect(layout.descriptionContent).toBeGreaterThan(layout.descriptionWidth);
        expect(layout.descriptionWidth).toBeGreaterThan(0);
        expect(layout.color).toBe(layout.nameColor);
        expect(layout.iconHeight).toBe(14);
        await page.screenshot({ path: `test-results/skill-suggestions-${width}-${theme}.png` });
      }
    }
    const dock = await page.locator(".composer").boundingBox();
    await editor.press("ArrowUp");
    await expect(panel.getByRole("option").last()).toHaveAttribute("aria-selected", "true");
    await expect(panel.getByRole("option").last()).toBeInViewport();
    expect(await panel.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect(await page.locator(".composer").boundingBox()).toEqual(dock);
    await editor.press("ArrowDown");
    await expect(panel.getByRole("option").first()).toBeInViewport();
    await editor.fill("$grwdoc");
    await expect(panel.locator("strong")).toHaveText("grill-with-docs");
    await editor.fill("$只读查库");
    await expect(panel.locator("strong")).toHaveText("ke-db");
    await expect(page.locator(".command-hint")).toHaveCount(0);
    await editor.fill("$线库");
    await expect(panel.getByRole("option")).toHaveCount(0);
    await expect(panel).toHaveText("暂无匹配技能");
    await editor.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(editor).toHaveText("$线库");
    for (const [trigger, key] of [
      ["$", "Enter"],
      ["¥", "Tab"],
      ["￥", "click"],
    ]) {
      await editor.fill(`前文 ${trigger}ke-db`);
      await expect(option).toBeVisible();
      if (key === "click") await option.click();
      else await editor.press(key);
      await expect(editor).toBeFocused();
      await expect(editor.locator(".inline-mention.skill")).toHaveText("ke-db");
      await expect(editor).toHaveText("前文 ke-db ");
      await expect(panel).toHaveCount(0);
      await page.keyboard.type("后文");
      await expect(editor).toHaveText("前文 ke-db 后文");
    }
    const canonical = `前文 [$ke-db](${await realpath(join(root, "ke-db", "SKILL.md"))}) 后文`;
    await expect
      .poll(() => page.evaluate((id) => window.ZPI.getDraft(id), id))
      .toMatchObject({
        ok: true,
        value: { text: canonical },
      });
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    editor = page.getByLabel("消息", { exact: true });
    panel = page.getByRole("listbox", { name: "技能", exact: true });
    await expect(editor.locator(".inline-mention.skill")).toHaveText("ke-db");
    await expect(editor.locator(".inline-mention.skill")).toHaveCSS("--mention-mask", /skill\.svg/);
    await expect(editor).toHaveText("前文 ke-db 后文");
    expect(server.requests).toHaveLength(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
