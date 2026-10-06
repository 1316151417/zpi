import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type ElectronApplication, expect, test } from "@playwright/test";
import sharp from "sharp";
import { done, fakeServer } from "../fake-server.ts";
import { select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("leaving the models tab during ChatGPT login restores settings controls", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-login-unmount-"));
  const app = await launchDesktop({ dir, url: "" });
  try {
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {};
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await page
      .locator(".provider-template-grid")
      .getByRole("button", { name: "OpenAI（ChatGPT）", exact: true })
      .click();
    await page.getByRole("button", { name: "Continue with ChatGPT", exact: true }).click();
    await expect(page.getByRole("button", { name: "取消登录", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "常规", exact: true }).click();
    await page.getByRole("button", { name: "模型", exact: true }).click();
    await expect(page.getByRole("button", { name: "新增提供商", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "新增提供商", exact: true }).click();
    await page.getByRole("button", { name: "自定义提供商", exact: true }).click();
    await expect(page.getByLabel("提供商名称", { exact: true })).toBeEnabled();
    await page.getByLabel("提供商名称", { exact: true }).fill("After cancellation");
    await expect(page.getByLabel("提供商名称", { exact: true })).toHaveValue("After cancellation");
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("reading position survives immediate session switching and closing before the bookmark timer fires", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-reading-flush-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const first = seedHistory(dir, cwd, 30);
  const second = seedHistory(dir, cwd, 1);
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await select(page, first.id);
    const scroll = await page.locator(".conversation").evaluate((element) => {
      element.scrollTop = 100;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return element.scrollTop;
    });
    await select(page, second.id);
    await select(page, first.id);
    await expect
      .poll(() => page.locator(".conversation").evaluate((element) => element.scrollTop))
      .toBe(scroll);
    const last = await page.locator(".conversation").evaluate((element) => {
      element.scrollTop = 150;
      element.dispatchEvent(new Event("scroll", { bubbles: true }));
      return element.scrollTop;
    });
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect
      .poll(() => page.locator(".conversation").evaluate((element) => element.scrollTop))
      .toBe(last);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

for (const selection of [
  [1, 1],
  [0, 2],
] as const) {
  test(`mixed image and text paste keeps subsequent typing after the inserted text (${selection})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "ZPI-mixed-paste-"));
    const server = await fakeServer((_, response) => done(response));
    const app = await launchDesktop({ dir, url: server.url });
    try {
      const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "white" } })
        .png()
        .toBuffer();
      const page = await app.firstWindow();
      const editor = page.getByLabel("消息", { exact: true });
      await editor.fill("前尾");
      await editor.evaluate((element, positions) => {
        const range = document.createRange();
        range.setStart(element.firstChild as Node, positions[0]);
        range.setEnd(element.firstChild as Node, positions[1]);
        window.getSelection()?.removeAllRanges();
        window.getSelection()?.addRange(range);
      }, selection);
      await editor.evaluate((element, bytes) => {
        const data = new DataTransfer();
        data.setData("text/plain", "粘贴");
        data.items.add(new File([new Uint8Array(bytes)], "paste.png", { type: "image/png" }));
        element.dispatchEvent(
          new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }),
        );
      }, Array.from(bytes));
      await editor.pressSequentially("X");
      const expected = selection[0] === 1 ? "前粘贴X尾" : "粘贴X";
      await expect(editor).toHaveText(expected);
      await expect(page.getByRole("button", { name: "预览 paste.png", exact: true })).toBeVisible();
      const id = await page.evaluate(() => localStorage.getItem("ZPI.selectedSession"));
      await expect
        .poll(async () => {
          const draft = await page.evaluate((id) => window.ZPI.getDraft(id as string), id);
          return draft.ok ? draft.value.text : draft.error.message;
        })
        .toBe(expected);
    } finally {
      await app.close();
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
}
