import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("user file mentions align with adjacent text and truncate within the message bubble", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-user-mention-layout-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "正文 [2.txt](./2.txt) text" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const file = join(cwd, "2.txt");
    const longName = `${"long-file-name-".repeat(14)}.txt`;
    const longFile = join(cwd, longName);
    await writeFile(file, "file content");
    await writeFile(longFile, "long file content");
    const id = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await select(page, id);
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill(
      `[2.txt](${file}) 是什么文件？\n正文 [2.txt](${file}) text\n[${longName}](${longFile}) 尾`,
    );
    await editor.press("Enter");
    const run = page.getByTestId("run").last();
    await expect(run).toHaveAttribute("data-status", "completed");
    const message = run.locator(".user-message-text");
    const references = message.locator(".inline-mention.file");
    await expect(references).toHaveCount(3);
    for (const fontSize of [14, 16]) {
      await page.evaluate((fontSize) => {
        document.documentElement.style.setProperty("--ui-font-size", `${fontSize}px`);
      }, fontSize);
      await expect(message).toHaveCSS("font-size", `${fontSize}px`);
      const offsets = await message.evaluate((element) => {
        const textTop = (node: Node) => {
          const range = document.createRange();
          range.setStart(node, 0);
          range.setEnd(node, 1);
          return range.getBoundingClientRect().top;
        };
        return Array.from(element.querySelectorAll(".inline-mention.file"))
          .slice(0, 2)
          .map((reference) => {
            const label = reference.querySelector(".reference-label")?.firstChild;
            const followingText = reference.nextSibling;
            if (!label || !followingText) throw Error("Missing reference or adjacent text");
            return Math.abs(textTop(label) - textTop(followingText));
          });
      });
      for (const offset of offsets) expect(offset).toBeLessThanOrEqual(1.5);
      const assistantOffset = await run.locator(".answer .message-file-link").evaluate((reference) => {
        const label = reference.querySelector(".reference-label")?.firstChild;
        const text = reference.nextSibling;
        if (!label || !text) throw Error("Missing assistant reference or text");
        const range = document.createRange();
        range.setStart(label, 0);
        range.setEnd(label, 1);
        const top = range.getBoundingClientRect().top;
        range.setStart(text, 0);
        range.setEnd(text, 1);
        return Math.abs(top - range.getBoundingClientRect().top);
      });
      expect(assistantOffset).toBe(0);
    }
    const label = references.last().locator(".reference-label");
    expect(await label.evaluate((element) => element.scrollWidth > element.clientWidth)).toBe(true);
    const width = await message.evaluate((element) => ({
      content: element.clientWidth,
      reference: element.querySelectorAll(".inline-mention.file")[2].getBoundingClientRect().width,
    }));
    expect(width.reference).toBeLessThanOrEqual(width.content);
    await page.evaluate(() => {
      document.documentElement.style.setProperty("--ui-font-size", "14px");
    });
    await page.screenshot({ path: "test-results/user-mention-alignment.png" });
    await references.first().click();
    await expect(page.getByRole("tab", { name: "2.txt", exact: true })).toBeVisible();
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
