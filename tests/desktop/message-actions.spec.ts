import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

async function selectText(locator: Locator) {
  await locator.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

test("selections inside or crossing Markdown file and web links can be added to the current task", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-link-selection-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "notes.md"), "document");
  const server = await fakeServer((_, response) => {
    send(
      response,
      chunk({ content: "正文 [文件链接](./notes.md) 中间 [网页链接](https://example.com) 结束" }),
    );
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {
        throw Error("Selecting a link must not open a browser");
      };
    });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("链接划词");
    await page.getByLabel("发送", { exact: true }).click();
    const run = page.getByTestId("run");
    await expect(run).toHaveAttribute("data-status", "completed");
    const paragraph = run.locator(".answer p");
    for (const selector of [".message-file-link .reference-label", ".message-web-link"]) {
      const bounds = await paragraph.locator(selector).boundingBox();
      if (!bounds) throw Error("Missing link layout");
      await page.mouse.move(bounds.x + 1, bounds.y + bounds.height / 2);
      await page.mouse.down();
      await page.mouse.move(bounds.x + bounds.width - 1, bounds.y + bounds.height / 2, { steps: 8 });
      await page.mouse.up();
      await expect(page.getByRole("button", { name: "添加到当前任务", exact: true })).toBeVisible();
      await expect(page.getByRole("tab", { name: "notes.md", exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
    }
    for (const [start, end, expected] of [
      ["file", "file", "文件链接"],
      ["web", "web", "网页链接"],
      ["before", "file", "正文 文件链接"],
      ["file", "after", "文件链接 中间 网页链接 结束"],
      ["file", "web", "文件链接 中间 网页链接"],
    ]) {
      const selectedText = await paragraph.evaluate(
        (element, { start, end }) => {
          const nodes: Record<string, Node | null | undefined> = {
            file: element.querySelector(".message-file-link .reference-label")?.firstChild,
            web: element.querySelector(".message-web-link")?.firstChild,
            before: element.firstChild,
            after: element.lastChild,
          };
          const first = nodes[start],
            last = nodes[end];
          if (!first || !last) throw Error("Missing link selection endpoints");
          const range = document.createRange();
          range.setStart(first, 0);
          range.setEnd(last, last.textContent?.length ?? 0);
          window.getSelection()?.removeAllRanges();
          window.getSelection()?.addRange(range);
          element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
          return window.getSelection()?.toString().trim() ?? "";
        },
        { start, end },
      );
      expect(selectedText.replace(/\s+/g, " ")).toBe(expected);
      const add = page.getByRole("button", { name: "添加到当前任务", exact: true });
      await expect(add).toBeVisible();
      await add.click();
      await expect
        .poll(async () => {
          const result = await page.evaluate(async () => {
            const id = localStorage.getItem("zpi.selectedSession") as string;
            return window.zpi.getDraft(id);
          });
          return result.ok ? result.value.selections?.[0]?.text : undefined;
        })
        .toBe(selectedText);
      await expect(page.getByRole("tab", { name: "notes.md", exact: true })).toHaveCount(0);
      await page.locator(".composer-container").getByLabel("移除对话引用").click();
    }
    await selectText(paragraph.locator(".message-file-link"));
    await expect(page.getByRole("button", { name: "添加到当前任务", exact: true })).toBeVisible();
    await page.screenshot({ path: "test-results/markdown-link-selection.png" });
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function expectZCodeSurfaces(page: Page, bubble: Locator, reference: Locator) {
  for (const theme of ["light", "dark"]) {
    await page.evaluate((value) => document.documentElement.setAttribute("data-theme", value), theme);
    await page.mouse.move(0, 0);
    const fill = theme === "light" ? "rgba(13, 13, 13, 0.03)" : "rgba(255, 255, 255, 0.05)";
    const hover = theme === "light" ? "rgba(13, 13, 13, 0.05)" : "rgba(255, 255, 255, 0.1)";
    await expect(bubble).toHaveCSS("background-color", fill);
    await expect(reference).toHaveCSS("background-color", fill);
    await reference.hover();
    await expect(reference).toHaveCSS("background-color", hover);
    const popover = page.getByRole("dialog", { name: "引用内容" });
    await expect(popover).toHaveCSS(
      "background-color",
      theme === "light" ? "rgb(240, 240, 240)" : "rgb(43, 43, 43)",
    );
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
  }
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  await page.mouse.move(0, 0);
}

test("message hover actions, inline editing, selection wire format, draft restart and fork navigation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-message-actions-")),
    project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, res, index) => {
    send(res, chunk({ content: `**reply ${index + 1}**: selected text` }));
    done(res);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    let page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("first user input");
    await page.getByLabel("发送", { exact: true }).click();
    const run = page.getByTestId("run");
    await expect(run).toHaveAttribute("data-status", "completed");
    await page.mouse.move(0, 0);
    await expect(run.locator(".user-message-actions")).toHaveCSS("opacity", "0");
    await run.locator(".user-message-text").hover();
    await expect(run.locator(".user-message-actions")).toHaveCSS("opacity", "1");
    const userCopy = run.locator(".user-message-actions").getByLabel("复制", { exact: true });
    await expect(userCopy.locator("svg")).toHaveAttribute("stroke-width", "1.5");
    await expect(run.getByLabel("编辑", { exact: true }).locator("svg")).toHaveAttribute(
      "stroke-width",
      "1.5",
    );
    await userCopy.click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("first user input");
    await expect(userCopy.locator(".lucide-check")).toHaveCount(1);
    await expect(userCopy.locator(".lucide-copy")).toHaveCount(1);
    await run.locator(".assistant-message-row").hover();
    await expect(run.locator(".assistant-message-actions")).toHaveCSS("opacity", "1");
    await expect(run.getByLabel("分叉", { exact: true }).locator("svg")).toHaveAttribute(
      "stroke-width",
      "1.5",
    );
    await expect(run.locator(".message-time")).toHaveText(/\d{2}:\d{2}/);
    await run.locator(".assistant-message-actions").getByLabel("复制", { exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("**reply 1**: selected text");
    await page.getByLabel("消息", { exact: true }).fill("keep main draft");
    await run.getByLabel("编辑", { exact: true }).click();
    const editing = page.getByRole("region", { name: "编辑消息" });
    await expect(editing.getByLabel("消息", { exact: true })).toBeFocused();
    await expect(editing.getByLabel("消息", { exact: true })).toHaveText("first user input");
    await editing.getByLabel("消息", { exact: true }).fill("cancel edit");
    await editing.getByLabel("消息", { exact: true }).press("Escape");
    await expect(editing).toHaveCount(0);
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("keep main draft");
    await run.getByLabel("编辑", { exact: true }).click();
    await editing.getByLabel("消息", { exact: true }).fill("edited user input");
    await editing.getByLabel("发送", { exact: true }).click();
    await expect(run).toHaveCount(1);
    await expect(run).toHaveAttribute("data-status", "completed");
    await expect(run.locator(".user-message-text")).toHaveText("edited user input");
    await expect(run.locator(".answer")).toContainText("reply 2");
    await page.locator(".composer-container").getByLabel("消息", { exact: true }).fill("explain");
    await selectText(run.locator(".answer p"));
    const add = page.getByRole("button", { name: "添加到当前任务", exact: true });
    await expect(add).toBeVisible();
    await expect(page.getByText("辅助对话", { exact: true })).toHaveCount(0);
    await add.click();
    await selectText(run.locator(".answer p"));
    await add.click();
    await expect(
      page.locator(".composer-container [data-conversation-selection-reference-count]"),
    ).toHaveAttribute("data-conversation-selection-reference-count", "1");
    await expect(page.locator(".composer-container").getByLabel("消息", { exact: true })).toHaveText(
      "explain",
    );
    await expectZCodeSurfaces(
      page,
      run.locator(".user-message"),
      page.locator(".composer-container .selection-reference-chip"),
    );
    await page.screenshot({ path: "test-results/message-actions-light.png" });
    await page.locator(".composer-container .selection-reference-chip").hover();
    const popover = page.getByRole("dialog", { name: "引用内容" });
    await expect(popover).toContainText("reply 2: selected text");
    const bounds = await popover.boundingBox();
    expect(bounds && bounds.y >= 12).toBeTruthy();
    await page.keyboard.press("Escape");
    await expect(popover).toHaveCount(0);
    // Wait for the canonical draft write before exercising process restart.
    await expect
      .poll(async () => {
        const draft = await page.evaluate(async () => {
          const sessions = await window.zpi.listRecentSessions();
          return sessions.ok ? window.zpi.getDraft(sessions.value[0].id) : null;
        });
        return draft?.ok ? draft.value.selections?.length : 0;
      })
      .toBe(1);
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    page = await app.firstWindow();
    await expect(
      page.locator(".composer-container [data-conversation-selection-reference-count]"),
    ).toHaveAttribute("data-conversation-selection-reference-count", "1");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    const messages = server.requests.at(-1)?.messages as unknown as { role: string; content: string }[];
    expect(messages.filter((message) => message.role === "user").at(-1)?.content).toContain(
      '# userselect:\n```userselect\n[{"text":"reply 2: selected text"}]\n```',
    );
    await expect(page.getByTestId("run").last().locator(".user-message-text")).toHaveText("explain");
    await expect(
      page.getByTestId("run").last().locator("[data-conversation-selection-reference-count]"),
    ).toHaveCount(1);
    await expectZCodeSurfaces(
      page,
      page.getByTestId("run").last().locator(".user-message"),
      page.getByTestId("run").last().locator(".selection-reference-chip"),
    );
    const parent = await page.evaluate(async () => {
      const sessions = await window.zpi.listRecentSessions();
      return sessions.ok ? sessions.value[0].id : "";
    });
    await page.getByTestId("run").first().getByLabel("分叉", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveCount(1);
    await expect(page.getByTestId("run").first().locator(".user-message-text")).toHaveText(
      "edited user input",
    );
    const sessions = await page.evaluate(() => window.zpi.listRecentSessions());
    expect(sessions.ok && sessions.value.filter((session) => !session.draft).length).toBe(2);
    const snapshot = await page.evaluate((id) => window.zpi.getSessionSnapshot(id), parent);
    expect(snapshot.ok && snapshot.value.view.runs.length).toBe(2);
    await page.evaluate(() => document.documentElement.setAttribute("data-theme", "dark"));
    await page.getByTestId("run").first().locator(".assistant-message-row").hover();
    await page.screenshot({ path: "test-results/message-actions-dark.png" });
    await page.getByRole("button", { name: "从对话中派生", exact: true }).click();
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").first().getByLabel("编辑", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("run").last().getByLabel("编辑", { exact: true })).toHaveCount(1);
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Markdown selections use source paths, cross-message selections are excluded and edit file conflicts retain the original turn", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-message-conflict-")),
    project = join(dir, "project");
  await mkdir(project);
  const documentPath = join(project, "notes.md"),
    changed = join(project, "changed.txt");
  await writeFile(documentPath, "# Notes\n\nselected document text\n");
  await writeFile(changed, "original\n");
  const server = await fakeServer((_, res, index) => {
    if (index === 0) {
      send(
        res,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write-file",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "changed.txt", content: "agent\n" }),
              },
            },
          ],
        }),
      );
      done(res, "tool_calls");
    } else {
      send(res, chunk({ content: "done\n\n[预览文档](./notes.md)" }));
      done(res);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("change file");
    await page.getByLabel("发送", { exact: true }).click();
    const turn = page.getByTestId("run");
    await expect(turn).toHaveAttribute("data-status", "completed");
    await page.locator(".answer").getByRole("button", { name: "预览文档", exact: true }).click();
    await expect(page.locator(".file-markdown-preview p")).toHaveText("selected document text");
    await selectText(page.locator(".file-markdown-preview p"));
    await page.getByRole("button", { name: "添加到当前任务", exact: true }).click();
    await expect(page.locator(".composer-container .selection-reference-chip")).toContainText(
      "notes.md · 引用",
    );
    const draft = await page.evaluate(async () => {
      const id = localStorage.getItem("zpi.selectedSession") as string;
      return window.zpi.getDraft(id);
    });
    expect(draft.ok && draft.value.selections?.[0]).toMatchObject({
      path: await realpath(documentPath),
      text: "selected document text",
    });
    await page.locator(".composer-container").getByLabel("移除对话引用").click();
    await expect(page.locator(".composer-container .selection-reference-chip")).toHaveCount(0);
    await turn.evaluate((element) => {
      const range = document.createRange();
      const user = element.querySelector(".user-message-text"),
        answer = element.querySelector(".answer p");
      if (!user || !answer) throw new Error("missing content");
      range.setStart(user, 0);
      range.setEnd(answer, answer.childNodes.length);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    });
    await expect(page.getByRole("button", { name: "添加到当前任务", exact: true })).toHaveCount(0);
    await writeFile(changed, "external\n");
    await turn.getByLabel("编辑", { exact: true }).click();
    const editing = page.getByRole("region", { name: "编辑消息" });
    await editing.getByLabel("消息", { exact: true }).fill("edited after conflict");
    await editing.getByLabel("对话 + 文件重置", { exact: true }).click();
    const conflict = page.getByRole("dialog", { name: "文件无法安全重置" });
    await expect(conflict).toBeVisible();
    await expect(conflict).toContainText("当前文件已被外部修改");
    expect(await readFile(changed, "utf8")).toBe("external\n");
    await expect(turn.locator(".user-message-text")).toHaveCount(0);
    await expect(turn).toHaveCount(1);
    await page.screenshot({ path: "test-results/message-actions-file-conflict.png" });
    await conflict.getByRole("button", { name: "取消", exact: true }).click();
    await expect(editing.getByLabel("消息", { exact: true })).toHaveText("edited after conflict");
    await editing.getByLabel("对话 + 文件重置", { exact: true }).click();
    await conflict.getByRole("button", { name: "仅重置对话并发送", exact: true }).click();
    await expect(conflict).toHaveCount(0);
    await expect(turn).toHaveCount(1);
    await expect(turn).toHaveAttribute("data-status", "completed");
    await expect(turn.locator(".user-message-text")).toHaveText("edited after conflict");
    expect(await readFile(changed, "utf8")).toBe("external\n");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
