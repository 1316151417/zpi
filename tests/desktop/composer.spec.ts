import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import sharp from "sharp";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { clipboardText, select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

test("add panel shares the composer width, lists files and preserves the insertion selection", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-composer-add-"));
  const project = join(dir, "workspace");
  await mkdir(join(project, "src"), { recursive: true });
  await writeFile(join(project, "src", "main.ts"), "export const main = 1;");
  await writeFile(join(project, "README.md"), "Project");
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    const add = page.getByRole("button", { name: "添加上下文", exact: true });
    const panel = page.getByRole("listbox", { name: "添加上下文", exact: true });
    await editor.fill("前尾");
    await editor.evaluate((el) => {
      const range = document.createRange();
      range.setStart(el.firstChild as Node, 1);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await add.click();
    await expect(panel).toBeFocused();
    await expect(add).toHaveAttribute("aria-expanded", "true");
    await expect(panel.locator(".composer-add-heading")).toHaveText(["添加", "文件"]);
    await expect(panel.getByRole("option")).toHaveCount(4);
    await expect(panel.getByRole("option", { name: "附件", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(panel.locator(".composer-add-hint code")).toHaveText(["@", "/", "$"]);
    await expect(panel.locator(".composer-add-hint")).toContainText("输入内容以搜索文件");
    const composerBounds = await page.locator(".composer").boundingBox();
    const panelBounds = await panel.boundingBox();
    if (!composerBounds || !panelBounds) throw new Error("Composer and add panel must be visible");
    expect(panelBounds.x).toBe(composerBounds.x);
    expect(panelBounds.width).toBe(composerBounds.width);
    expect(composerBounds.y - panelBounds.y - panelBounds.height).toBe(4);
    const clip = {
      x: panelBounds.x,
      y: panelBounds.y,
      width: panelBounds.width,
      height: composerBounds.y + composerBounds.height - panelBounds.y,
    };
    await page.screenshot({ path: "test-results/desktop-composer-add-light.png", clip });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-composer-add-dark.png", clip });
    await page.emulateMedia({ colorScheme: "light" });
    await panel.press("ArrowUp");
    await expect(panel.getByRole("option", { name: "src", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await panel.press("ArrowDown");
    await expect(panel.getByRole("option", { name: "附件", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await panel.getByRole("option", { name: "main.ts src/", exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("前main.ts 尾");
    await expect(editor.locator(".inline-mention.file")).toHaveAttribute(
      "data-markdown",
      `[main.ts](${await realpath(join(project, "src", "main.ts"))})`,
    );
    await page.keyboard.type("X");
    await expect(editor).toHaveText("前main.ts X尾");
    await add.click();
    await panel.press("Escape");
    await expect(panel).toHaveCount(0);
    await expect(add).toBeFocused();
    await add.press("Enter");
    await expect(panel).toBeVisible();
    await add.click();
    await expect(panel).toHaveCount(0);
    await expect(editor).toBeFocused();
    await add.click();
    await editor.click();
    await expect(panel).toHaveCount(0);
    await editor.fill("@main");
    await expect(page.getByRole("listbox", { name: "引用文件", exact: true })).toBeVisible();
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.getByRole("option", { name: "main.ts src/", exact: true }).click();
    await expect(editor).toBeFocused();
    await page.keyboard.type("Y");
    await expect(editor).toHaveText("main.ts Y");
    await editor.fill("@main");
    await expect(page.getByRole("listbox", { name: "引用文件", exact: true })).toBeVisible();
    await add.click();
    await expect(panel).toBeVisible();
    await expect(page.getByRole("listbox", { name: "引用文件", exact: true })).toHaveCount(0);
    await page.locator(".topbar-title").click();
    await expect(panel).toHaveCount(0);
    for (let i = 0; i < 12; i++) await writeFile(join(project, `file-${i}.txt`), "file");
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ width: 740, height: 560 });
    });
    await add.click();
    await expect(panel.getByRole("option")).toHaveCount(11);
    await panel.press("ArrowUp");
    await expect(panel.getByRole("option").last()).toBeInViewport();
    expect(await panel.locator(".command-options").evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
    expect((await panel.boundingBox())?.y).toBeGreaterThanOrEqual(0);
    await expect(panel.locator(".composer-add-hint")).toBeInViewport();
    await panel.press("ArrowDown");
    await expect(panel.getByRole("option", { name: "附件", exact: true })).toBeInViewport();
    await panel.press("Escape");
    await add.click();
    await expect(panel.getByRole("option")).toHaveCount(11);
    await expect(panel.locator(".composer-add-heading").first()).toBeInViewport();
    await page.screenshot({ path: "test-results/desktop-composer-add-small.png" });
    expect(server.requests).toHaveLength(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("add panel imports multiple attachments and retains the draft when the picker fails or is cancelled", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-composer-attachments-"));
  const project = join(dir, "workspace");
  await mkdir(project);
  const images = [join(dir, "first.png"), join(dir, "second.png")];
  for (const image of images)
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toFile(image);
  const server = await fakeServer((_, response) => done(response));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, images, url: server.url });
    const page = await app.firstWindow();
    const editor = page.getByLabel("消息", { exact: true });
    const add = page.getByRole("button", { name: "添加上下文", exact: true });
    const panel = page.getByRole("listbox", { name: "添加上下文", exact: true });
    await app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, method: string, args: unknown[]) => Promise<unknown>>;
      };
      const original = internal._invokeHandlers.get("ZPI:call");
      if (!original) throw Error("handler");
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (globalThis as unknown as { releasePicker: () => void }).releasePicker = release;
      ipcMain.removeHandler("ZPI:call");
      ipcMain.handle("ZPI:call", async (event, method, args) => {
        const result = await original(event, method, args);
        if (method === "pickImages") await gate;
        return result;
      });
    });
    await editor.fill("保留草稿");
    await add.click();
    await expect(panel).toContainText("暂无匹配文件");
    await panel.press("Enter");
    await expect(panel).toHaveCount(0);
    await expect(page.locator(".composer [role=status]")).toHaveCount(1);
    // A native picker takes focus away while it is open.
    await page.getByLabel("模型选择", { exact: true }).focus();
    await expect(editor).not.toBeFocused();
    await app.evaluate(() => (globalThis as unknown as { releasePicker: () => void }).releasePicker());
    await expect(page.locator(".composer .image-chip")).toHaveCount(2);
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("保留草稿");
    await page.keyboard.type("X");
    await expect(editor).toHaveText("保留草稿X");
    await page.getByRole("button", { name: "移除 first.png", exact: true }).click();
    await expect(page.locator(".composer .image-chip")).toHaveCount(1);
    await app.evaluate(() => {
      process.env.ZPI_TEST_IMAGE_FILES = "[]";
    });
    await add.click();
    await panel.getByRole("option", { name: "附件", exact: true }).click();
    await expect(page.locator(".composer .image-chip")).toHaveCount(1);
    await expect(page.locator(".composer [role=status]")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(page.getByRole("alert")).toHaveCount(0);
    await app.evaluate(
      (_, path) => {
        process.env.ZPI_TEST_IMAGE_FILES = JSON.stringify([path]);
      },
      join(dir, "missing.png"),
    );
    await add.click();
    await panel.press(" ");
    await expect(page.getByRole("alert")).toContainText("ENOENT");
    await expect(editor).toHaveText("保留草稿X");
    await expect(editor).toBeFocused();
    await expect(page.locator(".composer .image-chip")).toHaveCount(1);
    expect(server.requests).toHaveLength(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Shift+Enter moves the caret to a visible empty line and preserves repeated line breaks", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-newline-"));
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "reply" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const id = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await select(page, id);
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("第一行\n第二行\n第三行");
    const height = () => editor.evaluate((el) => el.getBoundingClientRect().height);
    const initialHeight = await height();
    await editor.press("Shift+Enter");
    expect(await height()).toBe(initialHeight + 20);
    await editor.press("Shift+Enter");
    expect(await height()).toBe(initialHeight + 40);
    await editor.press("Meta+Z");
    expect(await height()).toBe(initialHeight + 20);
    await editor.press("Meta+Shift+Z");
    expect(await height()).toBe(initialHeight + 40);
    await editor.pressSequentially("末行");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe("第一行\n第二行\n第三行\n\n末行");
    await editor.fill("首行");
    await editor.press("Shift+Enter");
    await editor.press("ArrowUp");
    await editor.pressSequentially("X");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe("X首行\n");
    await editor.fill("");
    await editor.press("Shift+Enter");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.insertText", { text: "中文" });
    await expect
      .poll(async () => {
        const draft = await page.evaluate((id) => window.ZPI.getDraft(id), id);
        return draft.ok ? draft.value.text : "";
      })
      .toBe("\n中文");
    expect(server.requests).toHaveLength(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Shift+Enter keeps the caret visible in a long pasted draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-newline-scroll-"));
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "reply" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const id = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await select(page, id);
    const editor = page.getByLabel("消息", { exact: true });
    const pasted = Array.from({ length: 40 }, (_, i) => `console output ${i}`).join("\n");
    await editor.focus();
    await editor.evaluate((el, pasted) => {
      const data = new DataTransfer();
      data.setData("text/plain", pasted);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, pasted);
    await expect(editor).toHaveText(pasted);
    for (let i = 0; i < 3; i++) {
      // Reproduce an editor scrolled away from its caret before inserting a newline.
      await editor.evaluate((el) => {
        el.scrollTop = 0;
      });
      await editor.press("Shift+Enter");
      await expect(editor).toBeFocused();
      await expect
        .poll(() =>
          editor.evaluate((el) => {
            const selected = window.getSelection();
            if (!selected?.rangeCount || !selected.isCollapsed || !el.contains(selected.focusNode))
              return false;
            const tail = el.querySelector("br[data-editor-tail]");
            // A collapsed range after a final newline has no rect; the tail renders its empty line.
            if (
              !tail ||
              selected.focusNode?.nextSibling !== tail ||
              selected.focusOffset !== selected.focusNode.textContent?.length
            )
              return false;
            const caret = tail.getBoundingClientRect();
            const viewport = el.getBoundingClientRect();
            return caret.height > 0 && caret.top >= viewport.top && caret.bottom <= viewport.bottom;
          }),
        )
        .toBe(true);
    }
    await editor.pressSequentially("last line");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe(`${pasted}\n\n\nlast line`);
    expect(server.requests).toHaveLength(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("empty prefix suggestions allow Enter to send while matching suggestions still insert references", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-prefix-input-"));
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "reply" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace"),
      skillDir = join(dir, "resources", "skills", "review");
    await mkdir(cwd);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(cwd, "main.txt"), "file content");
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\nSKILL BODY ON DEMAND",
    );
    const id = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await select(page, id);
    const editor = page.getByLabel("消息", { exact: true });
    for (const text of [
      "/中文读杠",
      "/tmp/missing",
      "$100",
      "$missing",
      "$中文",
      "@missing-file",
      "@someone@example.com",
    ]) {
      await editor.fill(text);
      if (text === "/tmp/missing" || text === "@someone@example.com")
        await expect(page.getByRole("listbox")).toHaveCount(0);
      else await expect(page.getByRole("listbox")).toBeVisible();
      await expect(page.getByRole("option")).toHaveCount(0);
      const index = server.requests.length;
      await editor.press("Enter");
      await expect.poll(() => server.requests.length).toBe(index + 1);
      expect(server.requests[index].messages).toContainEqual(
        expect.objectContaining({ role: "user", content: text }),
      );
      await expect(page.locator(".answer").last()).toHaveText("reply");
      await expect(editor).toHaveText("");
      await expect(page.getByRole("listbox")).toHaveCount(0);
      await expect(page.getByRole("alert")).toHaveCount(0);
    }
    const count = server.requests.length;
    // Hold caret restoration until after a newer user selection to expose stale frame callbacks.
    const resumeFrames = await page.evaluateHandle(() => {
      const original = window.requestAnimationFrame;
      const callbacks = new Map<number, FrameRequestCallback>();
      window.requestAnimationFrame = (callback) => {
        const id = original(() => {});
        callbacks.set(id, callback);
        return id;
      };
      return () => {
        window.requestAnimationFrame = original;
        for (const callback of callbacks.values()) callback(performance.now());
        callbacks.clear();
      };
    });
    await editor.fill("/init");
    await expect(page.getByRole("option")).toHaveCount(1);
    await editor.press("Tab");
    await expect(editor.locator(".inline-mention.command")).toHaveText("Init");
    await expect(editor.locator(".inline-mention.command")).toHaveAttribute("data-markdown", "/init");
    expect(server.requests).toHaveLength(count);
    await editor.press("Meta+A");
    await resumeFrames.evaluate((resume) => resume());
    await resumeFrames.dispose();
    await editor.pressSequentially("$review");
    await expect
      .poll(() => page.evaluate((id) => window.ZPI.getDraft(id), id))
      .toMatchObject({
        ok: true,
        value: { text: "$review" },
      });
    await expect(page.getByRole("option")).toHaveCount(1);
    await editor.press("Enter");
    await expect(editor.locator(".inline-mention.skill")).toHaveText("review");
    expect(server.requests).toHaveLength(count);
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(count + 1);
    expect(JSON.stringify(server.requests[count])).toContain("SKILL BODY ON DEMAND");
    await expect(editor).toHaveText("");
    await editor.fill("@main");
    await expect(page.getByRole("option")).toHaveCount(1);
    await editor.press("Tab");
    await expect(editor.locator(".inline-mention.file")).toHaveText("main.txt");
    expect(server.requests).toHaveLength(count + 1);
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(count + 2);
    expect(JSON.stringify(server.requests[count + 1])).toContain("Referenced project files");
    expect(JSON.stringify(server.requests[count + 1])).toContain(join(cwd, "main.txt"));
    await expect(editor).toHaveText("");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical reference editing, IME, selection, undo/redo, cross-session caret and restart drafts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-editor-"));
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "done" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const id = seedHistory(dir, cwd, 1).id,
      b = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await select(page, id);
    const file = join(cwd, "a.txt"),
      skill = join(dir, "resources", "skills", "review", "SKILL.md");
    await writeFile(file, "file content");
    await mkdir(join(dir, "resources", "skills", "review"), { recursive: true });
    await writeFile(skill, "---\nname: review\ndescription: review\n---\nReview");
    const editor = page.getByLabel("消息", { exact: true }),
      canonical = `前 [a.txt](${file}) 后 [$review](${skill}) 尾`;
    await editor.fill(canonical);
    await expect(editor.locator(".inline-mention")).toHaveCount(2);
    await expect(editor).toHaveText("前 a.txt 后 review 尾");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe(canonical);
    expect(await clipboardText(page, true)).toBe(canonical);
    await expect(editor).toHaveText("");
    await editor.press("Meta+Z");
    await expect(editor).toHaveText("前 a.txt 后 review 尾");
    await editor.press("Meta+Shift+Z");
    await expect(editor).toHaveText("");
    await editor.press("Meta+Z");
    await editor.press("Meta+A");
    await page.keyboard.insertText("选区替换");
    await expect(editor).toHaveText("选区替换");
    await editor.press("Meta+Z");
    await expect(editor.locator(".inline-mention")).toHaveCount(2);
    await editor.press("Meta+A");
    await editor.evaluate((el, text) => {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
    }, canonical);
    await expect(editor).toHaveText("前 a.txt 后 review 尾");
    await editor.evaluate((el) => {
      const chip = el.querySelector(".inline-mention") as Node;
      const range = document.createRange();
      range.setStartBefore(chip);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await editor.pressSequentially("左");
    await editor.evaluate((el) => {
      const chip = el.querySelector(".inline-mention") as Node;
      const range = document.createRange();
      range.setStartAfter(chip);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    });
    await editor.pressSequentially("右");
    await editor.press("Meta+A");
    expect(await clipboardText(page)).toBe(`前 左[a.txt](${file})右 后 [$review](${skill}) 尾`);
    await editor.press("Meta+Z");
    await editor.press("Meta+Z");
    await editor.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild as Node, 1);
      r.setEnd(el, 2);
      const s = window.getSelection();
      s?.removeAllRanges();
      s?.addRange(r);
    });
    await editor.press("Backspace");
    await expect(editor.locator(".inline-mention.file")).toHaveCount(0);
    await expect(editor.locator(".inline-mention.skill")).toHaveCount(1);
    await editor.press("Meta+Z");
    await expect(editor.locator(".inline-mention")).toHaveCount(2);
    await editor.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild as Node, 1);
      r.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    });
    await editor.pressSequentially("X");
    await expect(editor).toContainText("前X");
    await editor.press("Shift+Enter");
    await editor.pressSequentially("line");
    await expect(editor).toContainText("line");
    await editor.fill("");
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 });
    await expect(editor).toHaveText("中文");
    await page.evaluate(() => document.dispatchEvent(new Event("selectionchange")));
    await expect(page.getByRole("alert")).toHaveCount(0);
    expect(server.requests).toHaveLength(0);
    await cdp.send("Input.insertText", { text: "中文" });
    await expect
      .poll(async () => {
        const draft = await page.evaluate((id) => window.ZPI.getDraft(id), id);
        return draft.ok ? draft.value.text : draft.error.message;
      })
      .toBe("中文");
    await editor.press("Meta+Z");
    await expect(editor).toHaveText("");
    await editor.press("Meta+Shift+Z");
    await expect(editor).toHaveText("中文");
    // Commit IME in the middle of text, then continue typing through background renders.
    await editor.fill("前尾");
    await editor.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild as Node, 1);
      r.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    });
    await cdp.send("Input.imeSetComposition", { text: "当前", selectionStart: 2, selectionEnd: 2 });
    await cdp.send("Input.insertText", { text: "当前" });
    await expect
      .poll(async () => {
        const draft = await page.evaluate((id) => window.ZPI.getDraft(id), id);
        return draft.ok ? draft.value.text : "";
      })
      .toBe("前当前尾");
    await page.evaluate(async () => {
      const settings = await window.ZPI.getSettings();
      if (!settings.ok) throw Error(settings.error.message);
      await window.ZPI.updatePreferences(settings.value.interface);
    });
    await page.getByLabel("添加上下文", { exact: true }).click();
    // Native menus/window focus can clear the document selection while the editor is blurred.
    await page.evaluate(() => window.getSelection()?.removeAllRanges());
    await page.locator(".command-panel").press("Escape");
    await editor.focus();
    await editor.pressSequentially("X");
    await expect(editor).toHaveText("前当前X尾");
    await editor.press("Meta+Z");
    await expect(editor).toHaveText("前当前尾");
    await editor.fill(`甲乙 [missing](${cwd}/missing.txt)`);
    await editor.evaluate((el) => {
      const r = document.createRange();
      r.setStart(el.firstChild as Node, 1);
      r.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(r);
    });
    await select(page, b);
    await editor.fill("会话 B 草稿");
    await select(page, id);
    await editor.focus();
    await editor.pressSequentially("X");
    await expect(editor).toHaveText("甲X乙 missing");
    await editor.press("Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(editor).toHaveText("甲X乙 missing");
    await expect
      .poll(async () => {
        const r = await page.evaluate((id) => window.ZPI.getDraft(id), id);
        return r.ok ? r.value.text : "";
      })
      .toBe(`甲X乙 [missing](${cwd}/missing.txt)`);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("甲X乙 missing");
    await expect(page.locator(".draft-warning")).toContainText("原文已保留");
    await page.screenshot({ path: "test-results/desktop-draft-restored.png" });
    await select(page, b);
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("会话 B 草稿");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("accepted submit clears only submitted content, rejects duplicates and preserves other drafts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-submit-"));
  const server = await fakeServer((_, res) => {
    send(res, chunk({ content: "reply" }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    const a = seedHistory(dir, cwd, 1).id,
      b = seedHistory(dir, cwd, 1).id;
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await select(page, b);
    await page.getByLabel("消息", { exact: true }).fill("B 草稿");
    await select(page, a);
    await app.evaluate(({ ipcMain }) => {
      const internal = ipcMain as unknown as {
        _invokeHandlers: Map<string, (event: unknown, method: string, args: unknown[]) => Promise<unknown>>;
      };
      const original = internal._invokeHandlers.get("ZPI:call");
      if (!original) throw Error("handler");
      let release!: () => void;
      const gate = new Promise<void>((r) => {
        release = r;
      });
      (globalThis as unknown as { releaseSubmit: () => void }).releaseSubmit = release;
      ipcMain.removeHandler("ZPI:call");
      ipcMain.handle("ZPI:call", async (event, method, args) => {
        const result = await original(event, method, args);
        if (method === "submitInput") await gate;
        return result;
      });
    });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("实际提交的完整内容");
    await editor.press("Enter");
    await editor.press("Enter");
    await expect(page.locator(".answer").last()).toHaveText("reply");
    await editor.fill("发送期间新输入");
    // A later draft can happen to contain the same text as the submitted one.
    await editor.fill("实际提交的完整内容");
    await select(page, b);
    await editor.pressSequentially(" 新内容");
    await app.evaluate(() => (globalThis as unknown as { releaseSubmit: () => void }).releaseSubmit());
    await expect(editor).toHaveText("B 草稿 新内容");
    await select(page, a);
    await expect(editor).toHaveText("实际提交的完整内容");
    expect(server.requests).toHaveLength(1);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("sidebar expansion, distinct composer entries and equal-width pane tabs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-layout-"));
  await mkdir(join(dir, "workspace"));
  await writeFile(join(dir, "workspace", "main.txt"), "file content");
  await writeFile(join(dir, "workspace", "other.txt"), "other file");
  await mkdir(join(dir, ".agents", "skills", "review"), { recursive: true });
  await writeFile(
    join(dir, ".agents", "skills", "review", "SKILL.md"),
    "---\nname: review\ndescription: Review code\n---\nReview",
  );
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    let page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toBeVisible();
    const draftId = await page.evaluate(() => localStorage.getItem("ZPI.selectedSession"));
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(0);
    await page.getByLabel("新建任务", { exact: true }).first().click();
    expect(await page.evaluate(() => localStorage.getItem("ZPI.selectedSession"))).toBe(draftId);
    const text = `待发送 [main.txt](${join(dir, "workspace", "main.txt")})`;
    await page.getByLabel("消息", { exact: true }).fill(text);
    await expect
      .poll(async () => {
        const result = await page.evaluate((id) => window.ZPI.getDraft(id as string), draftId);
        return result.ok ? result.value.text : "";
      })
      .toBe(text);
    await app.close();
    app = await launchDesktop({ dir, url: server.url });
    page = await app.firstWindow();
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("待发送 main.txt");
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("ZPI.selectedSession"))).toBe(draftId);
    const editor = page.getByLabel("消息", { exact: true });
    await expect(editor).toBeVisible();
    const toggle = page.getByTestId("left-sidebar-toggle");
    const position = await toggle.boundingBox();
    await toggle.click();
    await expect(page.locator(".sidebar")).toBeHidden();
    await toggle.click();
    await expect(page.locator(".sidebar")).toBeVisible();
    expect(await toggle.boundingBox()).toEqual(position);
    await editor.fill("/");
    await expect(page.getByRole("listbox", { name: "指令", exact: true }).getByRole("option")).toHaveCount(2);
    await expect(page.getByRole("option")).toHaveText([/init/, /compact/]);
    await editor.fill("$");
    await page.getByRole("option", { name: /\$review/ }).click();
    await expect(editor.locator(".inline-mention.skill")).toHaveText("review");
    await expect(editor.locator(".inline-mention.skill")).toHaveAttribute(
      "data-markdown",
      /\[\$review\]\(.*SKILL\.md\)/,
    );
    await editor.fill("@main");
    await expect(page.getByRole("option")).toHaveCount(1);
    await page.getByRole("option", { name: /main.txt/ }).click();
    await expect(editor.locator(".inline-mention.file")).toHaveText("main.txt");
    await editor.fill("");
    await page.getByLabel("添加上下文", { exact: true }).click();
    await expect(page.locator(".command-panel input")).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(3);
    await page.screenshot({ path: "test-results/desktop-composer-files-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-composer-files-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.getByRole("listbox")).toHaveAttribute("aria-label", "添加上下文");
    await page.locator(".command-panel").press("ArrowDown");
    await page.locator(".command-panel").press("Enter");
    await expect(editor.locator(".inline-mention.file")).toHaveText("main.txt");
    await expect(editor.locator(".inline-mention.file")).toHaveAttribute(
      "data-markdown",
      /\[main\.txt\]\(.*main\.txt\)/,
    );
    await editor.fill("/");
    await page.screenshot({ path: "test-results/desktop-composer-commands.png" });
    await editor.press("Escape");
    const modelButton = page.getByLabel("模型选择", { exact: true });
    await expect(modelButton).toHaveText("fake");
    await expect(page.getByLabel("思考程度", { exact: true })).toHaveCount(0);
    await modelButton.click();
    await page.getByRole("menuitem", { name: "fake", exact: true }).hover();
    await page.getByRole("menuitem", { name: "高", exact: true }).click();
    await expect(modelButton).toHaveText("fake高");
    await expect(modelButton.locator(".model-reasoning")).toHaveText("高");
    await expect(modelButton).toBeEnabled();
    await modelButton.screenshot({ path: "test-results/desktop-model-reasoning.png" });
    await modelButton.click();
    await page.getByRole("menuitem", { name: "fake", exact: true }).hover();
    await page.getByRole("menuitem", { name: "关闭", exact: true }).click();
    await expect(modelButton).toHaveText("fake");
    await expect(modelButton.locator(".model-reasoning")).toHaveCount(0);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "浏览器", exact: true }).click();
    await page.getByLabel("新增侧栏标签").click();
    await page.getByRole("menuitem", { name: "浏览器", exact: true }).click();
    await expect(page.getByRole("tab")).toHaveCount(2);
    const widths = await page
      .locator(".pane-tab")
      .evaluateAll((tabs) => tabs.map((tab) => tab.getBoundingClientRect().width));
    expect(widths[0]).toBe(widths[1]);
    await page.getByLabel("关闭标签 浏览器", { exact: true }).last().click();
    await expect(page.locator(".right-pane")).toBeVisible();
    await page.getByLabel("关闭标签 浏览器", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.locator(".pane-empty-launcher")).toBeVisible();
    await page.screenshot({ path: "test-results/desktop-layout-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-layout-dark.png" });
    await editor.fill(`保留 [missing](${join(dir, "workspace", "missing.txt")})`);
    await editor.press("Enter");
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(editor).toHaveText("保留 missing");
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(0);
    await editor.fill("首条有效消息");
    await editor.press("Enter");
    await expect(page.locator(".answer")).toHaveText("ok");
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(1);
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await editor.fill("下一份待发送草稿");
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await expect(editor).toHaveText("下一份待发送草稿");
    await expect(page.locator(".recent-sessions .session-row")).toHaveCount(1);
    await expect(page.getByRole("alert")).toHaveCount(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
