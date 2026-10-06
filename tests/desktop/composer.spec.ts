import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { clipboardText, select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { seedHistory } from "../history-fixture.ts";

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
    await editor.fill("/init");
    await expect(page.getByRole("option")).toHaveCount(1);
    await editor.press("Tab");
    await expect(editor.locator(".inline-mention.command")).toHaveText("Init");
    await expect(editor.locator(".inline-mention.command")).toHaveAttribute("data-markdown", "/init");
    expect(server.requests).toHaveLength(count);
    await editor.fill("$review");
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
    await page.getByLabel("添加附件", { exact: true }).click();
    await page.getByRole("menuitem", { name: "插入文件引用" }).click();
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
    await page.getByLabel("添加附件", { exact: true }).click();
    await page.getByRole("menuitem", { name: "插入文件引用" }).click();
    await expect(page.locator(".command-panel input")).toHaveCount(0);
    await expect(page.getByRole("option")).toHaveCount(2);
    await page.screenshot({ path: "test-results/desktop-composer-files-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await page.screenshot({ path: "test-results/desktop-composer-files-dark.png" });
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.getByRole("listbox")).toHaveAttribute("aria-label", "引用文件");
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
