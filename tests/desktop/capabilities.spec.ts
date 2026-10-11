import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { ElectronApplication, Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

const exec = promisify(execFile);
const questions = [
  {
    header: "方案",
    question: "你想使用哪种方案？",
    multiSelect: false,
    options: [
      { label: "A", description: "第一种方案" },
      { label: "B", description: "第二种方案" },
    ],
  },
  {
    header: "能力",
    question: "需要哪些能力？",
    multiSelect: true,
    options: [
      { label: "读文件", description: "查看代码" },
      { label: "写文件", description: "修改代码" },
    ],
  },
];

test("question paging preserves keyboard focus, IME input, skipped answers and failed question records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-question-keyboard-"));
  const server = await fakeServer((_, response, index) => {
    if (index % 2 === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: `ask-${index}`,
              type: "function",
              function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "已收到回答" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    await page.getByRole("checkbox", { name: "工具-向用户提问", exact: true }).check();
    await page.getByLabel("关闭设置").click();
    const editor = page.getByLabel("消息", { exact: true });
    const card = page.getByRole("dialog", { name: "回答助手问题" });
    await editor.fill("键盘选择");
    await editor.press("Enter");
    await expect(card).toBeFocused();
    await card.press("ArrowDown");
    await expect(card.getByRole("option", { name: "A 第一种方案" })).toBeFocused();
    await card.getByRole("button", { name: "下一题" }).click();
    await expect(card).toContainText("2 / 2");
    await card.getByRole("button", { name: "上一题" }).click();
    const selected = card.getByRole("option", { name: "A 第一种方案" });
    await expect(selected).toHaveAttribute("aria-selected", "true");
    await expect(selected).toBeFocused();
    await selected.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(card).toContainText("2 / 2");
    await card.press("Tab");
    await page.keyboard.press("Space");
    await expect(card.getByRole("checkbox", { name: "读文件 查看代码" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    const custom = card.getByLabel("自定义回答", { exact: true });
    await custom.fill("中文回答");
    await custom.dispatchEvent("compositionstart");
    await custom.press("Enter");
    await expect(card).toBeVisible();
    await custom.dispatchEvent("compositionend");
    await custom.press("Enter");
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[1].messages)).toContain("中文回答");
    expect(JSON.stringify(server.requests[1].messages)).toContain("B");
    await editor.fill("跳过");
    await editor.press("Enter");
    await card.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await page.getByTestId("run").last().getByTestId("progress").click();
    const questionTools = page.getByTestId("run").last().locator('[data-tool-name="AskUserQuestion"]');
    await expect(questionTools.getByTestId("tool-summary")).toHaveText("已询问未回答，已自动继续");
    await editor.fill("中断询问");
    await editor.press("Enter");
    await expect(card).toBeVisible();
    const runId = await page.getByTestId("run").last().getAttribute("data-run-id");
    await page.evaluate(async (runId) => {
      const sessions = await window.ZPI.listRecentSessions();
      if (!sessions.ok || !runId) throw new Error("missing session");
      const result = await window.ZPI.abortRun({ sessionId: sessions.value[0].id, runId });
      if (!result.ok) throw new Error(result.error.message);
    }, runId);
    await expect(card).toHaveCount(0);
    const progress = page.getByTestId("run").last().getByTestId("progress");
    if ((await progress.getAttribute("aria-expanded")) === "false") await progress.click();
    await expect(questionTools.last().getByTestId("tool-summary")).toContainText("执行失败");
    await questionTools.last().getByTestId("tool-summary").click();
    await expect(questionTools.last().locator(".question-tool-answers")).toContainText("未提供回答");
    await expect(questionTools.last().locator(".tool-parameters, .tool-detail-error")).toHaveCount(0);
    await page.screenshot({ path: "test-results/question-records.png", animations: "disabled" });
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("prompt plugin switches update their preview and the first-send prompt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-prompt-plugins-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "完成" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    for (const name of ["提示词-多工具调用", "提示词-文件链接格式"]) {
      await expect(page.getByRole("checkbox", { name, exact: true })).toBeChecked();
      await page.getByRole("checkbox", { name, exact: true }).uncheck();
      await expect(page.getByRole("checkbox", { name, exact: true })).not.toBeChecked();
    }
    await page.getByRole("button", { name: "系统提示词", exact: true }).click();
    await expect(page.locator(".system-rules-preview")).toHaveText("未启用额外提示词能力。");
    await expect(page.locator(".prompt-preview")).not.toContainText("<system_rules>");
    await page.getByLabel("关闭设置").click();
    await page.getByLabel("消息", { exact: true }).fill("新会话");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[0].messages)).not.toContain("<system_rules>");
    await page.reload();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: "提示词-文件链接格式", exact: true })).not.toBeChecked();
    await expect(page.getByRole("checkbox", { name: "提示词-多工具调用", exact: true })).not.toBeChecked();
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
async function selectText(paragraph: Locator) {
  await paragraph.click();
  await paragraph.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
  });
}

test("long question cards retain ZCode scroll bounds and responsive collapse in both themes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-question-layout-"));
  const question = {
    header: "方案选择",
    question: `请选择要执行的方案。\n${"这里是需要完整显示的长问题说明。".repeat(14)}`,
    multiSelect: false,
    options: Array.from({ length: 4 }, (_, index) => ({
      label: `方案 ${index + 1}`,
      description: "需要考虑的详细说明。".repeat(12),
      preview: "```ts\nconsole.log('preview');\n```",
    })),
  };
  const server = await fakeServer((_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "long-question",
              type: "function",
              function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions: [question] }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "完成" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    await page.getByRole("checkbox", { name: "工具-向用户提问", exact: true }).check();
    await page.getByLabel("关闭设置").click();
    await page.getByLabel("消息", { exact: true }).fill("长问题");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    const card = page.getByRole("dialog", { name: "回答助手问题" });
    await expect(card).toBeVisible();
    await expect(card.locator(".question-preview")).toHaveCount(0);
    await page.setViewportSize({ width: 740, height: 520 });
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      const layout = await card.evaluate((element) => {
        const body = element.querySelector(".question-scroll-body");
        const bounds = element.getBoundingClientRect();
        const footer = element.querySelector("footer")?.getBoundingClientRect();
        return {
          height: bounds.height,
          maxHeight: innerHeight * 0.72,
          bottom: bounds.bottom,
          footerBottom: footer?.bottom,
          scrollable: !!body && body.scrollHeight > body.clientHeight,
        };
      });
      expect(layout.height).toBeLessThanOrEqual(layout.maxHeight + 1);
      expect(layout.footerBottom).toBeLessThan(layout.bottom);
      expect(layout.scrollable).toBe(true);
      await expect(card.getByRole("button", { name: "提交", exact: true })).toBeVisible();
      await page.screenshot({
        path: `test-results/question-card-${colorScheme}.png`,
        animations: "disabled",
      });
    }
    await card.getByRole("button", { name: "折叠问题弹窗", exact: true }).click();
    await expect(card.locator(".question-scroll-body")).toBeHidden();
    await expect(card.locator("footer")).toBeHidden();
    await card.getByRole("button", { name: "展开问题弹窗", exact: true }).click();
    await expect(card.locator(".question-scroll-body")).toBeVisible();
    await card.getByRole("button", { name: "忽略", exact: true }).click();
    await expect(card).toHaveCount(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("plugin settings add AskUserQuestion to a new chat, with paging, custom answers and continuation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-questions-e2e-"));
  const server = await fakeServer((_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "ask",
              type: "function",
              function: { name: "AskUserQuestion", arguments: JSON.stringify({ questions }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "已收到选择" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    const settings = page.locator(".capability-settings");
    await expect(settings.locator(".settings-row strong")).toHaveText([
      "提示词-多工具调用",
      "提示词-文件链接格式",
      "工具-向用户提问",
      "工具-提问自动继续",
    ]);
    for (const row of await settings.locator(".settings-row").all()) {
      const toggle = row.getByRole("checkbox");
      const checked = await toggle.isChecked();
      await row.locator("strong").click();
      await row.locator("small").click();
      await expect(toggle).toBeChecked({ checked });
    }
    await page.getByRole("checkbox", { name: "工具-向用户提问", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "工具-向用户提问", exact: true })).toBeChecked();
    await expect(settings.getByRole("checkbox", { name: "工具-提问自动继续", exact: true })).toBeChecked();
    const rows = await settings.locator(".settings-row").evaluateAll((rows) =>
      rows.map((row) => {
        const copy = row.querySelector(".settings-row-copy")?.getBoundingClientRect();
        const toggle = row.querySelector("input")?.getBoundingClientRect();
        return {
          copyRight: copy?.right,
          toggleLeft: toggle?.left,
          height: row.getBoundingClientRect().height,
        };
      }),
    );
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.toggleLeft).toBeGreaterThan(row.copyRight ?? 0);
      expect(row.height).toBeLessThan(100);
    }
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(settings.locator(".settings-switch > span").first()).toHaveCSS(
        "background-color",
        colorScheme === "light" ? "rgb(0, 0, 0)" : "rgb(255, 255, 255)",
      );
      await page.screenshot({
        path: `test-results/plugin-settings-${colorScheme}.png`,
        animations: "disabled",
      });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByLabel("关闭设置").click();
    await page.getByLabel("消息", { exact: true }).fill("帮我选方案");
    await page.getByLabel("发送", { exact: true }).click();
    const card = page.getByRole("dialog", { name: "回答助手问题" });
    await expect(card).toBeVisible();
    await expect(card).toContainText("1 / 2");
    const questionTool = page.locator('[data-tool-name="AskUserQuestion"]');
    await expect(questionTool.getByTestId("tool-summary")).toHaveText("正在询问");
    await expect(questionTool.locator(".tool-parameters")).toHaveCount(0);
    await expect(card.locator(".question-preview")).toHaveCount(0);
    await expect(card.locator(".question-option-description").first()).toHaveCSS("display", "inline");
    await expect(card.getByRole("button", { name: "继续", exact: true })).toHaveCSS("height", "32px");
    await expect(page.getByRole("button", { name: "停止提问计时", exact: true })).toBeVisible();
    await card.getByRole("option", { name: "A 第一种方案" }).click();
    await expect(card).toContainText("2 / 2");
    await expect(page.getByRole("button", { name: "等待回答", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "上一题" }).click();
    await expect(card.getByRole("option", { name: "A 第一种方案" })).toHaveAttribute("aria-selected", "true");
    await card.getByRole("button", { name: "下一题" }).click();
    await card.getByRole("checkbox", { name: "读文件 查看代码" }).click();
    await card.getByLabel("自定义回答", { exact: true }).fill("也检查测试");
    await page.screenshot({ path: "test-results/ask-user-question.png" });
    await card.getByRole("button", { name: "提交", exact: true }).click();
    await expect(card).toHaveCount(0);
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByTestId("progress").click();
    await expect(questionTool.getByTestId("tool-summary")).toHaveText("已询问2 个问题");
    await questionTool.getByTestId("tool-summary").click();
    await expect(questionTool.locator(".question-tool-answers")).toHaveText(
      "你想使用哪种方案？A需要哪些能力？读文件, 也检查测试",
    );
    await expect(questionTool.locator(".tool-parameters")).toHaveCount(0);
    await page.reload();
    await page.getByTestId("progress").click();
    await expect(questionTool.getByTestId("tool-summary")).toHaveText("已询问2 个问题");
    await questionTool.getByTestId("tool-summary").click();
    await expect(questionTool.locator(".question-tool-answers")).toContainText("也检查测试");
    expect(JSON.stringify(server.requests[1].messages)).toContain("也检查测试");
    expect(JSON.stringify(server.requests[0].tools)).toContain("AskUserQuestion");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("side chats route selected text to the active tab and preserve independent drafts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-side-e2e-"));
  const server = await fakeServer((_, response, index) => {
    send(response, chunk({ content: index === 0 ? "用于引用的主对话文字" : "辅助回答" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("主问题");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await main.getByLabel("消息", { exact: true }).fill("主草稿");
    const paragraph = main.locator(".answer p");
    await selectText(paragraph);
    const menu = page.getByRole("toolbar", { name: "选文操作", exact: true });
    const add = menu.getByRole("button", { name: "添加到当前任务", exact: true });
    const auxiliary = menu.getByRole("button", { name: "在辅助对话中提问", exact: true });
    await expect(menu.locator(".conversation-selection-divider")).toHaveCSS("width", "1px");
    await expect(add).toHaveCSS("border-radius", "0px");
    for (const [colorScheme, hover] of [
      ["light", "rgb(240, 240, 240)"],
      ["dark", "rgb(54, 54, 54)"],
    ] as const) {
      await page.emulateMedia({ colorScheme });
      await add.hover();
      await expect(add).toHaveCSS("background-color", hover);
      await expect(auxiliary).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await auxiliary.hover();
      await expect(auxiliary).toHaveCSS("background-color", hover);
      await expect(add).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
      await page.screenshot({
        path: `test-results/selection-menu-${colorScheme}.png`,
        animations: "disabled",
      });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.getByRole("button", { name: "在辅助对话中提问", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await expect(side).toBeVisible();
    await expect(side.getByLabel("消息", { exact: true })).toBeFocused();
    await expect(side.locator("[data-conversation-selection-reference-count]")).toHaveAttribute(
      "data-conversation-selection-reference-count",
      "1",
    );
    await expect(side.getByTestId("run")).toHaveCount(0);
    await expect(main.getByLabel("消息", { exact: true })).toHaveText("主草稿");
    await side.getByLabel("消息", { exact: true }).fill("解释一下");
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    expect(JSON.stringify(server.requests[1].messages)).toContain("主问题");
    expect(JSON.stringify(server.requests[1].messages)).toContain("userselect");
    await side.getByLabel("消息", { exact: true }).fill("第一份辅助草稿");
    await page.getByLabel("新增侧栏标签").click();
    await page.getByRole("menuitem", { name: "辅助对话", exact: true }).click();
    await expect(page.getByRole("tab", { name: "辅助对话 2", exact: true })).toBeVisible();
    await page
      .getByRole("region", { name: "辅助对话", exact: true })
      .getByLabel("消息", { exact: true })
      .fill("第二份辅助草稿");
    await page
      .getByRole("tab", { name: "辅助对话 1", exact: true })
      .getByRole("button", { name: "辅助对话 1", exact: true })
      .click();
    await expect(side.getByLabel("消息", { exact: true })).toHaveText("第一份辅助草稿");
    await page.screenshot({ path: "test-results/side-chat.png" });
    await main.getByLabel("消息", { exact: true }).fill("/btw 再解释一下");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(page.getByRole("tab", { name: "辅助对话 3", exact: true })).toBeVisible();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(main.getByTestId("run")).toHaveCount(1);
    expect(JSON.stringify(server.requests[2].messages)).toContain("再解释一下");
    await page.getByRole("button", { name: "关闭标签 辅助对话 3", exact: true }).click();
    await main.getByLabel("消息", { exact: true }).fill("/side");
    await main.getByRole("option", { name: /side/ }).click();
    await expect(page.getByRole("tab", { name: "辅助对话 4", exact: true })).toBeVisible();
    await expect(side.getByTestId("run")).toHaveCount(0);
    await expect(main.getByLabel("消息", { exact: true })).toHaveText("");
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("selection disables only the auxiliary action while its active chat awaits a response", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-side-question-e2e-"));
  const server = await fakeServer((_, response, index) => {
    if (index === 1) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "ask-side",
              type: "function",
              function: {
                name: "AskUserQuestion",
                arguments: JSON.stringify({ questions }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: index === 0 ? "用于引用的主对话文字" : "辅助回答" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "插件能力", exact: true }).click();
    await page.getByRole("checkbox", { name: "工具-向用户提问", exact: true }).check();
    await expect(page.getByRole("checkbox", { name: "工具-向用户提问", exact: true })).toBeChecked();
    await page.getByLabel("关闭设置").click();
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("主问题");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await selectText(main.locator(".answer p"));
    await page.getByRole("button", { name: "在辅助对话中提问", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await side.getByLabel("消息", { exact: true }).fill("辅助问题");
    await side.getByLabel("发送", { exact: true }).click();
    const card = side.getByRole("dialog", { name: "回答助手问题" });
    await expect(card).toBeVisible();
    await selectText(main.locator(".answer p"));
    const menu = page.getByRole("toolbar", { name: "选文操作", exact: true });
    const auxiliary = menu.getByRole("button", { name: "在辅助对话中提问", exact: true });
    await expect(auxiliary).toBeDisabled();
    await expect(auxiliary).toHaveAttribute("title", "请先处理辅助对话中的待处理请求。");
    await auxiliary.hover();
    await expect(auxiliary).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const add = menu.getByRole("button", { name: "添加到当前任务", exact: true });
    await expect(add).toBeEnabled();
    await add.click();
    await expect(main.locator("[data-conversation-selection-reference-count]")).toHaveAttribute(
      "data-conversation-selection-reference-count",
      "1",
    );
    await expect(card).toBeVisible();
    await card.getByRole("option", { name: "A 第一种方案" }).click();
    await card.getByRole("checkbox", { name: "读文件 查看代码" }).click();
    await card.getByRole("button", { name: "提交", exact: true }).click();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await selectText(side.locator(".answer p"));
    await expect(menu).toHaveCount(0);
    await selectText(main.locator(".answer p"));
    await expect(auxiliary).toBeEnabled();
    await auxiliary.click();
    await expect(page.getByRole("tab", { name: "辅助对话 1", exact: true })).toBeVisible();
    await expect(side.locator("[data-conversation-selection-reference-count]").first()).toHaveAttribute(
      "data-conversation-selection-reference-count",
      "1",
    );
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("Markdown preview selections open an auxiliary chat with their source path and retain the parent draft", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-markdown-side-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "notes.md"), "# Notes\n\nselected document text\n");
  const server = await fakeServer((_, response, index) => {
    send(response, chunk({ content: index === 0 ? "[预览文档](./notes.md)" : "文档解释" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const main = page.locator("main");
    await main.getByLabel("消息", { exact: true }).fill("阅读文档");
    await main.getByLabel("发送", { exact: true }).click();
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await main.getByLabel("消息", { exact: true }).fill("保留主草稿");
    await main.locator(".answer").getByRole("button", { name: "预览文档", exact: true }).click();
    await selectText(page.locator(".file-markdown-preview p"));
    const menu = page.getByRole("toolbar", { name: "选文操作", exact: true });
    await expect(menu.getByRole("button")).toHaveText(["添加到当前任务", "在辅助对话中提问"]);
    await menu.getByRole("button", { name: "在辅助对话中提问", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await expect(side).toBeVisible();
    await expect(side.getByLabel("消息", { exact: true })).toBeFocused();
    await expect(side.locator(".selection-reference-chip")).toContainText("notes.md · 引用");
    await expect(main.getByLabel("消息", { exact: true })).toHaveText("保留主草稿");
    await side.getByLabel("消息", { exact: true }).fill("解释选文");
    await side.getByLabel("发送", { exact: true }).click();
    await expect(side.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const messages = JSON.stringify(server.requests[1].messages);
    expect(messages).toContain("selected document text");
    expect(messages).toContain("notes.md");
    await expect(main.getByTestId("run")).toHaveCount(1);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("first-send worktree settings create a short branch and switch the prompt and workspace", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-worktree-e2e-"));
  const project = join(dir, "project");
  await mkdir(project);
  const git = async (...args: string[]) => (await exec("git", ["-C", project, ...args])).stdout.trim();
  await git("init", "-b", "main");
  await git("config", "user.email", "test@example.test");
  await git("config", "user.name", "Test");
  await writeFile(join(project, "tracked.txt"), "original");
  await git("add", ".");
  await git("commit", "-m", "Initial");
  const checkoutGate = join(dir, "hold-checkout");
  await writeFile(checkoutGate, "");
  await writeFile(
    join(project, ".git", "hooks", "post-checkout"),
    `#!/bin/sh\nwhile [ -e "${checkoutGate}" ]; do sleep 0.05; done\n`,
    { mode: 0o755 },
  );
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "worktree ready" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByRole("button", { name: "配置本地环境", exact: true }).click();
    const toggle = page.getByRole("menuitemcheckbox", { name: "新工作树", exact: true });
    const environment = page.locator(".environment-menu");
    for (const checked of ["true", "false", "true"]) {
      await expect(toggle).toBeEnabled();
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", checked);
      await expect(environment).toBeVisible();
    }
    await expect(environment).toHaveCSS("border-radius", "8px");
    await expect(toggle.locator(".environment-switch")).toHaveCSS("width", "32px");
    expect((await environment.boundingBox())?.height).toBeLessThan(120);
    for (const colorScheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme });
      await expect(page.locator("html")).toHaveAttribute("data-theme", colorScheme);
      await expect(page.locator(".composer")).toHaveCSS(
        "background-color",
        colorScheme === "light" ? "rgb(255, 255, 255)" : "rgb(43, 43, 43)",
      );
      await page.screenshot({
        path: `test-results/worktree-settings-${colorScheme}.png`,
        animations: "disabled",
      });
    }
    await page.emulateMedia({ colorScheme: "light" });
    await page.keyboard.press("Escape");
    await page.getByLabel("消息", { exact: true }).fill("开始工作");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect(page.getByTestId("run-preparation")).toBeVisible();
    await expect(page.getByTestId("run-preparation")).toContainText("正在创建工作树");
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("");
    await page.getByLabel("消息", { exact: true }).fill("后续输入");
    await expect(page.getByLabel("消息", { exact: true })).toHaveText("后续输入");
    await page.getByLabel("消息", { exact: true }).fill("");
    const pendingTask = page.getByTestId("session-row").filter({ hasText: "开始工作" });
    await page.getByRole("button", { name: "新建任务", exact: true }).first().click();
    await pendingTask.click();
    await expect(page.getByTestId("run-preparation")).toContainText("正在创建工作树");
    await page.screenshot({ path: "test-results/worktree-preparation.png", animations: "disabled" });
    expect(server.requests).toHaveLength(0);
    await rm(checkoutGate, { force: true });
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("run-preparation")).toHaveCount(0);
    const record = await page.evaluate(async () => {
      const result = await window.ZPI.listRecentSessions();
      if (!result.ok) throw new Error(result.error.message);
      return result.value.find((record) => !record.draft);
    });
    expect(record?.worktree?.branch).toMatch(/^[a-z0-9]{4}$/);
    expect(record?.cwd).toBe(join(dir, "worktree", record?.worktree?.branch ?? "", "project"));
    expect(JSON.stringify(server.requests[0].messages)).toContain(record?.cwd);
    expect(await readFile(join(record?.cwd ?? "", "tracked.txt"), "utf8")).toBe("original");
    await expect(page.getByRole("button", { name: "配置本地环境", exact: true })).toHaveCount(0);
    await page.locator("main").getByLabel("消息", { exact: true }).fill("/side");
    await page.locator("main").getByRole("option", { name: /side/ }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    await expect(side).toBeVisible();
    const childId = await side.getAttribute("data-side-chat-session");
    const workspace = await page.evaluate(async (id) => {
      if (!id) throw new Error("missing child session");
      const result = await window.ZPI.getWorkspaceInfo(id);
      if (!result.ok) throw new Error(result.error.message);
      return result.value;
    }, childId);
    expect(workspace.cwd).toBe(record?.cwd);
  } finally {
    await rm(checkoutGate, { force: true });
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
