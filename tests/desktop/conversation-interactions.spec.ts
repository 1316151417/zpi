import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("long user messages match ZCode collapse and preserve copying and find navigation", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-user-collapse-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "完成。" }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const text = `${"检查长消息的折叠和展开。\n".repeat(60)}末尾定位词`;
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill(text);
    await page.getByLabel("发送", { exact: true }).click();
    const run = page.getByTestId("run").first();
    const body = run.locator(".user-message-body");
    const content = body.locator(".user-message-content");
    await expect(run).toHaveAttribute("data-status", "completed");
    await expect(body).toHaveAttribute("data-expandable", "true");
    await expect(content).toHaveCSS("max-height", "120px");
    await expect(content).toHaveCSS("mask-image", /linear-gradient/);
    await body.getByRole("button", { name: "展开", exact: true }).click();
    await expect(body).toHaveAttribute("data-expanded", "true");
    await expect.poll(() => content.evaluate((el) => el.clientHeight)).toBeGreaterThan(120);
    await expect(content).toHaveCSS("mask-image", "none");
    const collapse = body.getByRole("button", { name: "收起", exact: true });
    await collapse.focus();
    await collapse.press("Enter");
    await expect(content).toHaveCSS("max-height", "120px");
    await run.locator(".user-message-row").hover();
    await run.locator(".user-message-actions").getByLabel("复制", { exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(text);
    await page.screenshot({ path: "test-results/user-message-collapsed.png" });
    await editor.focus();
    await editor.press("Meta+f");
    const find = page.getByRole("dialog", { name: "在任务中查找", exact: true });
    await find.getByRole("textbox").fill("末尾定位词");
    await expect(find.getByRole("status")).toHaveText("1/1");
    await expect(body).toHaveAttribute("data-expanded", "true");
    await expect
      .poll(() =>
        page.evaluate(() => {
          const range = [...(CSS.highlights.get("zpi-conversation-find-active") ?? [])][0];
          const viewport = document.querySelector(".conversation")?.getBoundingClientRect();
          if (!(range instanceof Range) || !viewport) return false;
          const hit = range.getBoundingClientRect();
          return hit.top >= viewport.top && hit.bottom <= viewport.bottom;
        }),
      )
      .toBe(true);
    await find.getByRole("button", { name: "关闭查找", exact: true }).click();
    await editor.fill("短消息");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(page.getByTestId("run").last().locator(".user-message-toggle")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("side chats reuse the smallest free number and retain other conversations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-chat-number-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "完成。" }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("主对话");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const add = async () => {
      await page.getByLabel("新增侧栏标签", { exact: true }).click();
      await page.getByRole("menuitem", { name: "辅助对话", exact: true }).click();
    };
    await expect(page.getByRole("tab", { name: "辅助对话 1", exact: true })).toBeVisible();
    await add();
    await expect(page.getByRole("tab", { name: "辅助对话 2", exact: true })).toBeVisible();
    await add();
    const third = page.getByRole("region", { name: "辅助对话", exact: true });
    await expect(page.getByRole("tab", { name: "辅助对话 3", exact: true })).toBeVisible();
    await third.getByLabel("消息", { exact: true }).fill("保留第三份草稿");
    await page.getByRole("tab", { name: "辅助对话 2", exact: true }).hover();
    await page.getByLabel("关闭标签 辅助对话 2", { exact: true }).click();
    await expect(page.getByRole("tab", { name: "辅助对话 2", exact: true })).toHaveCount(0);
    await add();
    await expect(page.getByRole("tab", { name: "辅助对话 2", exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "辅助对话 4", exact: true })).toHaveCount(0);
    await page
      .getByRole("tab", { name: "辅助对话 3", exact: true })
      .getByRole("button", { name: "辅助对话 3", exact: true })
      .click();
    await expect(third.getByLabel("消息", { exact: true })).toHaveText("保留第三份草稿");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("side chat submits through the composer without renderer-only fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-side-chat-send-"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "辅助回复" }));
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("主对话");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
    const side = page.getByRole("region", { name: "辅助对话", exact: true });
    const editor = side.getByLabel("消息", { exact: true });
    await editor.fill("辅助对话消息");
    await editor.press("Enter");
    await expect
      .poll(() => server.requests.some((body) => JSON.stringify(body).includes("辅助对话消息")))
      .toBe(true);
    await expect(side.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await expect(side.locator(".answer").last()).toContainText("辅助回复");
    await expect(side.locator(".notice-input")).toHaveCount(0);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("clicking inside the current task clears a completion dot and persists the acknowledgement", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-read-current-task-"));
  const finish = deferred();
  const server = await fakeServer(async (_, response) => {
    send(response, chunk({ content: "任务结果" }));
    await finish.promise;
    done(response);
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("清除当前任务的蓝点");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.locator(".answer")).toContainText("任务结果");
    const id = await page.evaluate(async () => {
      const id = localStorage.getItem("zpi.selectedSession");
      const other = await window.zpi.createSession(null);
      if (!id || !other.ok) throw new Error("Missing task");
      // Keep the renderer on the first task while host focus points elsewhere.
      await window.zpi.activateSession(other.value.id);
      return id;
    });
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const dot = page.locator(`[data-session-id="${id}"] [data-unread-indicator]`);
    await expect(dot).toBeVisible();
    await page.locator(".answer").click();
    await expect(dot).toHaveCount(0);
    const unread = await page.evaluate(async (id) => {
      const snapshot = await window.zpi.getSessionSnapshot(id);
      if (!snapshot.ok) throw new Error(snapshot.error.message);
      return snapshot.value.session.unreadAt;
    }, id);
    expect(unread).toBeUndefined();
    await page.reload();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(dot).toHaveCount(0);
  } finally {
    finish.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("an absolute HTML link previews the streamed write before the file exists and opens after completion", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-pending-html-"));
  const path = join(dir, "zpi-stream-stall-explainer.html");
  const source = "<!doctype html><html><title>写入中的预览</title><body>生成中的页面</body></html>";
  const finish = deferred();
  const server = await fakeServer(async (_, response, index) => {
    if (index === 0) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write-html",
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path, content: source }).slice(0, -2) },
            },
          ],
        }),
      );
      await finish.promise;
      send(response, chunk({ tool_calls: [{ index: 0, function: { arguments: '"}' } }] }));
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "完成。" }));
      done(response);
    }
  });
  let app: Awaited<ReturnType<typeof launchDesktop>>;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("消息", { exact: true }).fill("生成 HTML 页面");
    await page.getByLabel("发送", { exact: true }).click();
    const chip = page.locator('[data-tool-name="write"] .tool-file-chip');
    await expect(chip).toContainText("zpi-stream-stall-explainer.html");
    await expect(readFile(path)).rejects.toThrow("ENOENT");
    await chip.click();
    await expect(page.locator(".pending-file-preview")).toContainText(source);
    await expect(page.locator(".notice-window")).toHaveCount(0);
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".pending-file-preview")).toHaveCount(0);
    expect(await readFile(path, "utf8")).toBe(source);
    await page.locator(".changes-pane").getByRole("button", { name: "打开文件", exact: true }).click();
    await expect(page.getByLabel("浏览器地址", { exact: true })).toBeVisible();
    await expect(page.getByRole("tab", { name: "写入中的预览", exact: true })).toBeVisible();
    await expect(page.locator(".notice-window")).toHaveCount(0);
  } finally {
    finish.resolve();
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
