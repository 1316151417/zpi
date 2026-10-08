import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("references from earlier assistant segments produce one card below the final answer", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-card-turn-")));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "report.pdf"), "pdf");
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string }[];
    if (!messages.some((message) => message.role === "tool")) {
      send(response, chunk({ content: "可以查看 report.pdf，我先检查工作目录。" }));
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "pwd",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "pwd" }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "处理完成。" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("检查");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".assistant-preview-title")).toHaveText("report.pdf");
    const answer = page.locator(".answer").last();
    await expect(answer).toHaveText("处理完成。");
    const card = page.locator(".assistant-preview-card");
    await expect(card).toHaveCount(1);
    const a = await answer.boundingBox();
    const c = await card.boundingBox();
    expect(a).not.toBeNull();
    expect(c?.y).toBeGreaterThanOrEqual((a?.y ?? 0) + (a?.height ?? 0));
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("delayed file checks stay with their task, stable projections share checks and interruption reveals cards", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-card-races-")));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "a.pdf"), "pdf");
  await writeFile(join(project, "b.pdf"), "pdf");
  const server = await fakeServer((body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: user === "B" ? "b.pdf" : "a.pdf" }));
    if (user !== "中断") done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      const bus = ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      };
      const original = bus._invokeHandlers.get("ZPI:call");
      if (!original) throw new Error("missing IPC handler");
      const state = { calls: [] as string[], release: undefined as (() => void) | undefined };
      (globalThis as typeof globalThis & { previewRace: typeof state }).previewRace = state;
      ipcMain.removeHandler("ZPI:call");
      ipcMain.handle("ZPI:call", async (event, method, args) => {
        const result = await original(event, method, args);
        if (method === "checkPreviewFiles") {
          state.calls.push(args[0]);
          if (state.calls.length === 1)
            await new Promise<void>((resolve) => {
              state.release = resolve;
            });
        }
        return result;
      });
    });
    await page.getByLabel("添加项目", { exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("A");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const a = await page.locator(".session-row.active").getAttribute("data-session-id");
    await expect
      .poll(() =>
        app?.evaluate(
          () =>
            (globalThis as typeof globalThis & { previewRace: { calls: string[] } }).previewRace.calls.length,
        ),
      )
      .toBe(1);
    await expect(page.locator(".assistant-preview-card")).toHaveCount(0);
    await page.locator(".project-title").hover();
    await page.getByLabel("新建任务 project", { exact: true }).click();
    await editor.fill("B");
    await editor.press("Enter");
    await expect(page.locator(".assistant-preview-title")).toHaveText("b.pdf");
    await app.evaluate(() =>
      (globalThis as typeof globalThis & { previewRace: { release?: () => void } }).previewRace.release?.(),
    );
    await page.getByLabel("筛选和排序", { exact: true }).click();
    await page.getByRole("menuitemradio", { name: "创建时间" }).click();
    await expect(page.locator(".assistant-preview-title")).toHaveText("b.pdf");
    await page.locator(`[data-session-id="${a}"] .session-name`).click();
    await expect(page.locator(".assistant-preview-title")).toHaveText("a.pdf");
    expect(
      await app.evaluate(
        () =>
          (globalThis as typeof globalThis & { previewRace: { calls: string[] } }).previewRace.calls.length,
      ),
    ).toBe(3);
    await editor.fill("中断");
    await editor.press("Enter");
    await expect(page.getByTestId("run").last().locator(".answer")).toHaveText("a.pdf");
    await expect(page.getByTestId("run").last().locator(".assistant-preview-card")).toHaveCount(0);
    await page.getByLabel("停止", { exact: true }).click();
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "aborted");
    await expect(page.getByTestId("run").last().locator(".assistant-preview-title")).toHaveText("a.pdf");
    await page.getByRole("button", { name: "B", exact: true }).click();
    await rm(join(project, "a.pdf"));
    await page.locator(`[data-session-id="${a}"] .session-name`).click();
    await expect
      .poll(() =>
        app?.evaluate(
          () =>
            (globalThis as typeof globalThis & { previewRace: { calls: string[] } }).previewRace.calls.length,
        ),
      )
      .toBe(7);
    await expect(page.locator(".assistant-preview-card")).toHaveCount(0);
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("rewind removes old turn cards and failed change reads suppress only gated formats", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "ZPI-card-rewind-")));
  const project = join(dir, "project");
  await mkdir(project);
  await writeFile(join(project, "ok.pdf"), "pdf");
  const server = await fakeServer((body, response) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    const user = messages.filter((m) => m.role === "user").at(-1)?.content;
    if (user === "生成" && !messages.some((m) => m.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write",
              type: "function",
              function: {
                name: "write",
                arguments: JSON.stringify({ path: "out.html", content: "<h1>preview</h1>" }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "out.html ok.pdf" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByLabel("添加项目", { exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("生成");
    await editor.press("Enter");
    await expect(page.locator(".assistant-preview-card")).toHaveCount(2);
    const id = await page.locator(".session-row.active").getAttribute("data-session-id");
    const runId = await page.getByTestId("run").getAttribute("data-run-id");
    const result = await page.evaluate(
      async ({ id, runId }) =>
        window.ZPI.editUserMessage(id, runId, {
          text: "讨论",
          fileReferences: [],
          attachments: [],
          workspaceMode: "rewind",
        }),
      { id: id ?? "", runId: runId ?? "" },
    );
    expect(result.ok).toBe(true);
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".assistant-preview-title")).toHaveText("ok.pdf");
    await app.evaluate(({ ipcMain }) => {
      const bus = ipcMain as typeof ipcMain & {
        _invokeHandlers: Map<string, (...args: unknown[]) => Promise<unknown>>;
      };
      const original = bus._invokeHandlers.get("ZPI:call");
      if (!original) throw new Error("missing IPC handler");
      ipcMain.removeHandler("ZPI:call");
      ipcMain.handle("ZPI:call", (event, method, args) =>
        method === "getChanges"
          ? { ok: false, error: { code: "storage", message: "fixture snapshot unavailable" } }
          : original(event, method, args),
      );
    });
    await page.reload();
    await expect(page.locator(".assistant-preview-title")).toHaveText("ok.pdf");
  } finally {
    await app?.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
