import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { select } from "../helpers/composer.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";
import { seedHistory } from "../history-fixture.ts";

const packaged = Boolean(process.env.ZPI_TEST_PACKAGED_APP);

async function conversationScope(page: Page, side: boolean) {
  if (side) {
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await page.locator(".pane-empty-launcher").getByRole("button", { name: "辅助对话", exact: true }).click();
  }
  return page.locator(side ? ".side-chat-pane" : "main");
}

async function runningRun(scope: Locator) {
  const current = scope.getByTestId("run").last();
  await expect(current).toHaveAttribute("data-status", "running");
  const runId = await current.getAttribute("data-run-id");
  if (!runId) throw new Error("Missing run ID");
  return { runId, run: scope.locator(`[data-run-id="${runId}"]`) };
}

for (const side of [false, true]) {
  for (const action of ["queue-now", "modified-enter"] as const) {
    test(`immediate send preempts a stalled stream and drains remaining inputs once (${side ? "side" : "main"}, ${action})`, async () => {
      const dir = await mkdtemp(join(tmpdir(), "zpi-immediate-send-"));
      const cwd = join(dir, "workspace");
      await mkdir(cwd);
      const mainId = seedHistory(dir, cwd, 1).id;
      const release = deferred();
      const server = await fakeServer(async (body, response) => {
        const user = (body.messages as unknown as { role: string; content: string }[])
          .filter((m) => m.role === "user")
          .at(-1)?.content;
        if (user === "hold waiting") {
          if (action === "modified-enter") send(response, chunk({ content: "Original partial remains." }));
          else response.flushHeaders();
          await release.promise;
        }
        if (!response.destroyed) {
          send(response, chunk({ content: "Replacement received." }));
          done(response);
        }
      });
      let app: ElectronApplication | undefined;
      try {
        app = await launchDesktop({ dir, url: server.url, packaged });
        const page = await app.firstWindow();
        const scope = await conversationScope(page, side);
        const sessionId = side ? await scope.getAttribute("data-side-chat-session") : mainId;
        if (!sessionId) throw new Error("Missing session ID");
        const editor = scope.getByLabel("消息", { exact: true });
        await editor.fill("hold waiting");
        await editor.press("Enter");
        await expect.poll(() => server.requests.length).toBe(1);
        const { runId, run: original } = await runningRun(scope);
        if (action === "modified-enter")
          await expect(original.locator(".answer")).toHaveText("Original partial remains.");
        for (const text of action === "queue-now"
          ? ["queued before", "immediate replacement", "queued after"]
          : ["queued before", "queued after"]) {
          await editor.fill(text);
          await editor.press("Enter");
        }
        expect(server.requests).toHaveLength(1);
        if (action === "queue-now") {
          await scope
            .getByTestId("queue-item")
            .filter({ hasText: "immediate replacement" })
            .getByRole("button", { name: "立即", exact: true })
            .click();
        } else {
          await editor.fill("immediate replacement");
          await editor.press(`${process.platform === "darwin" ? "Meta" : "Control"}+Enter`);
        }
        // The original response is still gated: progress must come from cancellation,
        // not from waiting for its next model/tool boundary.
        await expect(original).toHaveAttribute("data-status", "aborted");
        await expect(scope.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
        await expect(scope.getByTestId("queue-item")).toHaveCount(0);
        await expect.poll(() => server.requests.length).toBe(4);
        expect(
          server.requests.map(
            (request) =>
              (request.messages as unknown as { role: string; content: string }[])
                .filter((m) => m.role === "user")
                .at(-1)?.content,
          ),
        ).toEqual(["hold waiting", "immediate replacement", "queued before", "queued after"]);
        // Every replacement is a separate run; no user-facing immediate input is
        // silently stored as a guide on the aborted run.
        await expect(scope.locator(".guide-message")).toHaveCount(0);
        const ids = await scope
          .getByTestId("run")
          .evaluateAll((runs) => runs.map((run) => run.getAttribute("data-run-id")));
        expect(new Set(ids).size).toBe(ids.length);
        if (action === "modified-enter")
          await expect(original.locator(".answer")).toHaveText("Original partial remains.");
        await app.close();
        app = await launchDesktop({ dir, url: server.url, packaged });
        const restoredPage = await app.firstWindow();
        // Auxiliary tabs are transient; verify their durable history through the host.
        const restored = await restoredPage.evaluate((id) => window.zpi.getSessionSnapshot(id), sessionId);
        if (!restored.ok) throw new Error(restored.error.message);
        expect(restored.value.view.runs.find((run) => run.runId === runId)?.status).toBe("aborted");
        expect(
          restored.value.view.runs.filter((run) => run.userMessage === "immediate replacement"),
        ).toHaveLength(1);
        expect(restored.value.view.queue?.items ?? []).toHaveLength(0);
        if (!side)
          await expect(restoredPage.locator(`[data-run-id="${runId}"]`)).toHaveAttribute(
            "data-status",
            "aborted",
          );
        expect(server.requests).toHaveLength(4);
      } finally {
        release.resolve();
        await runCleanup([() => rm(dir, { recursive: true, force: true }), server.close, () => app?.close()]);
      }
    });
  }
}

for (const side of [false, true]) {
  test(`failed immediate delivery unlocks editing and removal, preserves the draft and retries once (${side ? "side" : "main"})`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "zpi-immediate-recovery-"));
    const cwd = join(dir, "workspace");
    await mkdir(cwd);
    seedHistory(dir, cwd, 1);
    const release = deferred();
    const server = await fakeServer(async (_body, response, index) => {
      send(response, chunk({ content: "answer" }));
      if (index === 0) await release.promise;
      if (!response.destroyed) done(response);
    });
    let app: ElectronApplication | undefined;
    try {
      app = await launchDesktop({ dir, url: server.url, packaged });
      const page = await app.firstWindow();
      const scope = await conversationScope(page, side);
      const editor = scope.getByLabel("消息", { exact: true });
      await editor.fill("hold");
      await editor.press("Enter");
      await expect.poll(() => server.requests.length).toBe(1);
      const { run: original } = await runningRun(scope);
      for (const text of ["recover this input", "remove this input"]) {
        await editor.fill(text);
        await editor.press("Enter");
      }
      await app.evaluate(({ ipcMain }) => {
        const bus = ipcMain as typeof ipcMain & {
          _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
        };
        const original = bus._invokeHandlers.get("zpi:call");
        if (!original) throw new Error("Missing IPC handler");
        const failures = new Set(["sendQueuedNow", "submitInput"]);
        ipcMain.removeHandler("zpi:call");
        ipcMain.handle("zpi:call", (event, method, args) => {
          if (failures.delete(method))
            return { ok: false, error: { code: "storage", message: "Temporary delivery failure" } };
          return original(event, method, args);
        });
      });
      const row = scope.getByTestId("queue-item").filter({ hasText: "recover this input" });
      await row.getByRole("button", { name: "立即", exact: true }).click();
      await expect(scope.getByRole("alert")).toBeVisible();
      for (const name of ["立即", "编辑", "移除待发送消息"])
        await expect(row.getByRole("button", { name, exact: true })).toBeEnabled();
      await expect(original).toHaveAttribute("data-status", "running");
      expect(server.requests).toHaveLength(1);
      await scope
        .getByTestId("queue-item")
        .filter({ hasText: "remove this input" })
        .getByRole("button", { name: "移除待发送消息", exact: true })
        .click();
      await row.getByRole("button", { name: "编辑", exact: true }).click();
      await expect(editor).toHaveText("recover this input");
      await expect(scope.getByTestId("queue-item")).toHaveCount(0);
      const shortcut = `${process.platform === "darwin" ? "Meta" : "Control"}+Enter`;
      await editor.press(shortcut);
      await expect(scope.getByRole("alert")).toBeVisible();
      await expect(editor).toHaveText("recover this input");
      await expect(original).toHaveAttribute("data-status", "running");
      expect(server.requests).toHaveLength(1);
      await editor.press(shortcut);
      await expect(editor).toHaveText("");
      await expect(original).toHaveAttribute("data-status", "aborted");
      await expect(scope.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
      await expect(scope.getByTestId("run").filter({ hasText: "recover this input" })).toHaveCount(1);
      expect(server.requests).toHaveLength(2);
    } finally {
      release.resolve();
      await runCleanup([() => rm(dir, { recursive: true, force: true }), server.close, () => app?.close()]);
    }
  });
}

test("immediate sending while reading old history preserves navigator entries, previews, sidebar behavior and task isolation", async () => {
  test.setTimeout(60_000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-immediate-navigator-"));
  const cwd = join(dir, "workspace");
  await mkdir(cwd);
  const session = seedHistory(dir, cwd, 100);
  const other = seedHistory(dir, cwd, 5);
  const originalRelease = deferred(),
    replacementRelease = deferred();
  const server = await fakeServer(async (_body, response, index) => {
    send(
      response,
      chunk({ content: `${index === 0 ? "Original" : "Replacement"} response.\n\n`.repeat(60) }),
    );
    await (index === 0 ? originalRelease.promise : replacementRelease.promise);
    if (!response.destroyed) done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url, packaged });
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1280, height: 900 });
    await select(page, session.id);
    const rail = page.getByRole("navigation", { name: "对话问题导航" });
    await expect(rail).toHaveAttribute("aria-busy", "false");
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("hold original");
    await editor.press("Enter");
    await expect.poll(() => server.requests.length).toBe(1);
    const { runId: originalId, run: original } = await runningRun(page.locator("main"));
    await expect(original.locator(".answer")).toContainText("Original response.");
    await expect(rail.getByRole("button", { name: "跳转到第 101 条问题", exact: true })).toHaveAttribute(
      "aria-current",
      "location",
    );
    const jump = async (index: number, key: string) => {
      await rail.locator(".conversation-navigator-rail").evaluate((node, index) => {
        node.scrollTop = Math.max(0, (index - 5) * 10);
      }, index);
      await rail.getByRole("button", { name: `跳转到第 ${index} 条问题`, exact: true }).click();
      await expect(page.locator(`[data-query-key="${key}"]`)).toBeInViewport();
      await expect(
        rail.getByRole("button", { name: `跳转到第 ${index} 条问题`, exact: true }),
      ).toHaveAttribute("aria-current", "location");
    };
    await jump(1, "run-0:user");
    await editor.fill("immediate from history");
    await editor.press("Enter");
    await page.getByTestId("queue-item").getByRole("button", { name: "立即", exact: true }).click();
    await expect.poll(() => server.requests.length).toBe(2);
    const replacement = page.getByTestId("run").last();
    await expect(replacement.locator(".answer")).toContainText("Replacement response.");
    const replacementId = await replacement.getAttribute("data-run-id");
    await jump(102, `${replacementId}:user`);
    await rail.getByRole("button", { name: "跳转到第 102 条问题", exact: true }).hover();
    const preview = page.locator(".conversation-navigator-tooltip:visible");
    await expect(preview).toContainText("immediate from history");
    await expect(preview).toContainText("Replacement response.");
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.locator(".conversation-navigator")).toBeHidden();
    await expect(preview).toHaveCount(0);
    await expect(replacement).toHaveAttribute("data-status", "running");
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await expect(rail).toBeVisible();
    await jump(101, `${originalId}:user`);
    await expect(page.locator(`[data-run-id="${originalId}"]`)).toHaveAttribute("data-status", "aborted");
    replacementRelease.resolve();
    await expect(page.locator(`[data-run-id="${replacementId}"]`)).toHaveAttribute(
      "data-status",
      "completed",
    );
    await select(page, other.id);
    await expect(rail).toHaveAttribute("aria-busy", "false");
    await expect(rail.getByRole("button")).toHaveCount(5);
    await jump(2, "run-1:user");
    await select(page, session.id);
    await expect(rail).toHaveAttribute("aria-busy", "false");
    await jump(102, `${replacementId}:user`);
    await page.setViewportSize({ width: 700, height: 900 });
    await expect(page.locator(".conversation-navigator")).toBeHidden();
    await page.setViewportSize({ width: 1280, height: 900 });
    await expect(rail).toBeVisible();
    await jump(1, "run-0:user");
    await page.reload();
    await expect(rail).toHaveAttribute("aria-busy", "false");
    await jump(102, `${replacementId}:user`);
    await expect(page.getByTestId("queue-item")).toHaveCount(0);
    expect(server.requests).toHaveLength(2);
  } finally {
    originalRelease.resolve();
    replacementRelease.resolve();
    await runCleanup([() => rm(dir, { recursive: true, force: true }), server.close, () => app?.close()]);
  }
});
