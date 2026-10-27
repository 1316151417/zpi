import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { presetModels } from "zpi-ai";
import { availablePresets, modelReasoningLabel } from "../../packages/desktop/src/shared/config.ts";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("send-next sends the draft immediately, preserves the queue, and sends the queue head when empty", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-queue-shortcut-"));
  const server = await fakeServer((_, response) => send(response, chunk({ content: "waiting" })));
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const primary = await page.evaluate(() => (window.zpi.platform === "darwin" ? "Meta" : "Control"));
    const editor = page.getByLabel("消息", { exact: true });
    await editor.focus();
    await editor.press(`${primary}+Enter`);
    await expect(editor).toHaveText("");
    expect(server.requests).toHaveLength(0);
    await editor.fill("running");
    await editor.press(`${primary}+Enter`);
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "running");
    await expect(editor).toHaveText("");
    for (const text of ["queued first", "queued second"]) {
      await editor.fill(text);
      await editor.press("Enter");
    }
    const rows = page.getByTestId("queue-item");
    await expect(rows).toHaveCount(2);
    await editor.fill("send this draft immediately");
    await editor.evaluate((element) => {
      const primary = window.zpi.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
      for (const flags of [{ repeat: true }, { isComposing: true }, { keyCode: 229 }])
        element.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ...primary, ...flags }),
        );
    });
    await expect(rows).toHaveCount(2);
    expect(server.requests).toHaveLength(1);
    await editor.evaluate((element) => {
      const primary = window.zpi.platform === "darwin" ? { metaKey: true } : { ctrlKey: true };
      // Two separate keydowns before IPC settles must still dispatch only once.
      for (let i = 0; i < 2; i++)
        element.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter", ...primary }));
    });
    await expect(rows).toHaveCount(2);
    await expect(editor).toHaveText("");
    await expect(page.getByTestId("run").first()).toHaveAttribute("data-status", "aborted");
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect.poll(() => server.requests.length).toBe(2);
    const immediate = server.requests.at(-1)?.messages as unknown as { role: string; content: string }[];
    expect(immediate.filter((message) => message.role === "user").at(-1)?.content).toBe(
      "send this draft immediately",
    );
    await editor.press(`${primary}+Enter`);
    await expect(rows).toHaveCount(1);
    await expect(rows).toContainText("queued second");
    await expect.poll(() => server.requests.length).toBe(3);
    const last = server.requests.at(-1)?.messages as unknown as { role: string; content: string }[];
    expect(last.filter((message) => message.role === "user").at(-1)?.content).toBe("queued first");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("model shortcut navigates models and supported reasoning levels, confirms explicitly, and restores the composer on cancel", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-model-shortcut-"));
  const server = await fakeServer((_, response) => done(response));
  const models = presetModels("openai-chatgpt")
    .filter((model) => model.name === "GPT-6.1 Sol" || model.name === "GPT-6 Astra")
    .map((model) => ({ ...model, defaultThinkingLevel: "low" }));
  expect(models).toHaveLength(2);
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.evaluate(
      async ({ url, modelsJson }) => {
        const result = await window.zpi.saveProvider({
          id: "keyboard-models",
          name: "Keyboard models",
          baseUrl: url,
          apiKey: "isolated-test-key",
          models: JSON.parse(modelsJson),
        });
        if (!result.ok) throw new Error(result.error.message);
      },
      { url: server.url, modelsJson: JSON.stringify(models) },
    );
    await page.reload();
    const primary = await page.evaluate(() => (window.zpi.platform === "darwin" ? "Meta" : "Control"));
    const editor = page.getByLabel("消息", { exact: true });
    const trigger = page.getByLabel("模型选择", { exact: true });
    await editor.fill("preserved draft");
    await editor.press(`${primary}+l`);
    await expect(page.getByRole("menuitem", { name: "fake", exact: true })).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const firstModel = page.getByRole("menuitem", { name: models[0].name, exact: true });
    await expect(firstModel).toBeFocused();
    await expect(page.locator(".reasoning-menu")).toHaveCount(0);
    await expect(trigger).toContainText("fake");
    await page.keyboard.press("ArrowRight");
    const levels = page.locator(".reasoning-menu [role=menuitem]");
    const supported = availablePresets(models[0]);
    expect(supported).not.toContain("none");
    await expect(levels).toHaveText(supported.map((reasoning) => modelReasoningLabel(models[0], reasoning)));
    await expect(levels.first()).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(page.locator(".reasoning-menu")).toHaveCount(0);
    await expect(firstModel).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(levels.first()).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(levels.nth(1)).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toContainText(models[0].name ?? models[0].id);
    await expect(trigger).toContainText(modelReasoningLabel(models[0], supported[1]));
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("preserved draft");
    await editor.press(`${primary}+l`);
    await expect(firstModel).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: models[1].name, exact: true })).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(trigger).toContainText(models[0].name ?? models[0].id);
    await editor.press(`${primary}+l`);
    await expect(firstModel).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(page.getByRole("menuitem", { name: models[1].name, exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(trigger).toContainText(models[1].name ?? models[1].id);
    await expect(trigger).toContainText("中");
    await expect(editor).toBeFocused();
    await expect(editor).toHaveText("preserved draft");
    expect(server.requests).toHaveLength(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("side-chat shortcuts affect only the focused composer and return focus there", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-shortcut-"));
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    send(response, chunk({ content: "reply" }));
    if (messages.filter((message) => message.role === "user").at(-1)?.content === "initial") done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const primary = await page.evaluate(() => (window.zpi.platform === "darwin" ? "Meta" : "Control"));
    const main = page.locator("main");
    const mainEditor = main.getByLabel("消息", { exact: true });
    await mainEditor.fill("initial");
    await mainEditor.press("Enter");
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.locator(".side-chat-pane");
    for (const [pane, label] of [
      [main, "main"],
      [side, "side"],
    ] as const) {
      const editor = pane.getByLabel("消息", { exact: true });
      await editor.fill(`${label} running`);
      await editor.press("Enter");
      await expect(pane.getByTestId("run").last()).toHaveAttribute("data-status", "running");
      await editor.fill(`${label} queued`);
      await editor.press("Enter");
      await expect(pane.getByTestId("queue-item")).toHaveCount(1);
      await editor.fill(`${label} draft`);
    }
    const sideEditor = side.getByLabel("消息", { exact: true });
    await sideEditor.press(`${primary}+Enter`);
    await expect(side.getByTestId("queue-item")).toHaveCount(1);
    await expect(side.getByTestId("run").first()).toHaveAttribute("data-status", "aborted");
    await expect(main.getByTestId("queue-item")).toHaveCount(1);
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(mainEditor).toHaveText("main draft");
    await expect(sideEditor).toHaveText("");
    await expect(side.getByTestId("run").last()).toContainText("side draft");
    await sideEditor.fill("preserved side draft");
    await sideEditor.press(`${primary}+l`);
    await expect(side.getByLabel("模型选择", { exact: true })).toHaveAttribute("aria-expanded", "true");
    await expect(main.getByLabel("模型选择", { exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${primary}+l`);
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(sideEditor).toBeFocused();
    await page.keyboard.press(`${primary}+l`);
    await expect(side.getByLabel("模型选择", { exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(sideEditor).toBeFocused();
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await page.evaluate(async () => {
      const settings = await window.zpi.getSettings();
      if (!settings.ok) throw Error(settings.error.message);
      settings.value.shortcuts.bindings["stop-run"] =
        window.zpi.platform === "darwin" ? "Shift+Command+Enter" : "Control+Shift+Enter";
      const result = await window.zpi.updateShortcuts(settings.value.shortcuts);
      if (!result.ok) throw Error(result.error.message);
    });
    await sideEditor.press(`${primary}+Shift+Enter`);
    await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await expect(sideEditor).toHaveText("preserved side draft");
    await mainEditor.press(`${primary}+Shift+Enter`);
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
    await expect(mainEditor).toHaveText("main draft");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("a retained question in a hidden auxiliary pane does not block active workspace or composer shortcuts", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-hidden-question-shortcuts-"));
  const server = await fakeServer((_, response, index) => {
    if (index === 1) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "hidden-side-question",
              type: "function",
              function: {
                name: "AskUserQuestion",
                arguments: JSON.stringify({
                  questions: [
                    {
                      header: "方案",
                      question: "选择一个方案？",
                      multiSelect: false,
                      options: [
                        { label: "A", description: "第一种方案" },
                        { label: "B", description: "第二种方案" },
                      ],
                    },
                  ],
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "reply" }));
      if (index === 0) done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const primary = await page.evaluate(() => (window.zpi.platform === "darwin" ? "Meta" : "Control"));
    const main = page.locator("main");
    const editor = main.getByLabel("消息", { exact: true });
    await editor.fill("initial");
    await editor.press("Enter");
    await expect(main.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.locator(".side-chat-pane");
    await side.getByLabel("消息", { exact: true }).fill("ask me");
    await side.getByLabel("消息", { exact: true }).press("Enter");
    const question = page.locator(".right-pane .user-question-card");
    await expect(question).toBeVisible();
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(question).toBeAttached();
    await expect(question).toBeHidden();
    await editor.fill("main running");
    await editor.press("Enter");
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await editor.fill("main queued");
    await editor.press("Enter");
    await expect(main.getByTestId("queue-item")).toHaveCount(1);
    await editor.fill("preserved main draft");
    await editor.press(`${primary}+l`);
    await expect(main.getByLabel("模型选择", { exact: true })).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("menu")).toHaveCount(0);
    await expect(editor).toBeFocused();
    await expect(main.getByTestId("run").last()).toHaveAttribute("data-status", "running");
    await editor.fill("");
    await editor.press(`${primary}+Enter`);
    await expect(main.getByTestId("queue-item")).toHaveCount(0);
    await expect(editor).toHaveText("");
    await expect.poll(() => server.requests.length).toBe(4);
    await page.keyboard.press(`${primary}+[`);
    await expect(page.getByTestId("left-sidebar-toggle")).toHaveAttribute("aria-expanded", "false");
    await page.keyboard.press(`${primary}+[`);
    await expect(page.getByTestId("left-sidebar-toggle")).toHaveAttribute("aria-expanded", "true");
    await page.keyboard.press(`${primary}+n`);
    await expect(page.locator("main")).toHaveClass(/draft-main/);
    await expect(question).toBeAttached();
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
