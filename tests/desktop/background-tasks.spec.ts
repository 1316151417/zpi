import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";

async function checkTaskMenuLayer(page: Page, panel: Locator, theme: string) {
  await panel.getByRole("button", { name: "状态面板展开策略", exact: true }).click();
  const menu = page.getByRole("menuitemradio", { name: "自动展开", exact: true });
  await expect(menu).toBeVisible();
  await page.screenshot({ path: test.info().outputPath(`task-menu-${theme}.png`), animations: "disabled" });
  const layers = await page.locator(".task-activity").evaluate((element) => {
    const menu = document.querySelector(".task-activity-menu");
    if (!(element instanceof HTMLElement) || !menu) throw new Error("Missing task menu");
    const bounds = menu.getBoundingClientRect();
    const panelBounds = element.getBoundingClientRect();
    const previous = element.style.pointerEvents;
    // Modal menus disable background pointer events; restore them briefly so hit testing
    // detects a panel painted above the menu instead of clicking through that occlusion.
    element.style.pointerEvents = "auto";
    try {
      return {
        overlaps: bounds.top < panelBounds.bottom && bounds.bottom > panelBounds.top,
        unobscured: [0.25, 0.5, 0.75].every((x) =>
          menu.contains(document.elementFromPoint(bounds.left + bounds.width * x, bounds.top + 8)),
        ),
      };
    } finally {
      element.style.pointerEvents = previous;
    }
  });
  expect(layers.overlaps).toBe(true);
  expect(layers.unobscured).toBe(true);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
}

test("one compact task panel manages agents and services and retains finished history without dismissal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-task-panel-"));
  const server = await fakeServer((body, response) => {
    const tools = (body.tools as { function: { name: string } }[]).map((tool) => tool.function.name);
    if (!tools.includes("Agent")) {
      send(response, chunk({ content: "Inspecting the code" }));
      return;
    }
    const messages = body.messages as { role: string; content: string }[];
    const last = messages.at(-1);
    if (
      !messages.some((message) => message.role === "tool") ||
      (last?.role === "user" && last.content === "Again")
    ) {
      const repeated = last?.content === "Again";
      const calls = [
        ...(repeated
          ? []
          : [
              {
                name: "Agent",
                args: { description: "Inspect source", prompt: "Inspect", run_in_background: true },
              },
            ]),
        {
          name: "bash",
          args: {
            command: "echo 'Server ready'; sleep 30",
            description: repeated ? "Second server" : "Dev server",
            run_in_background: true,
          },
        },
      ];
      send(
        response,
        chunk({
          tool_calls: calls.map((call, index) => ({
            index,
            id: `${repeated ? "again" : "initial"}-${index}`,
            type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          })),
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "Tasks started" }));
      done(response);
    }
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.evaluate(async () => {
      const result = await window.zpi.setCapabilityEnabled("subagents", true);
      if (!result.ok) throw new Error(result.error.message);
    });
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("Start tasks");
    await editor.press("Enter");
    await expect(page.locator("main .answer")).toContainText("Tasks started");
    const panel = page.getByRole("complementary", { name: "任务状态", exact: true });
    await expect(panel).toHaveAttribute("data-display-mode", "auto");
    await expect(panel.getByRole("button", { name: "展开状态", exact: true })).toHaveText("2 运行");
    await expect(panel.locator(".task-summary-icon .lucide-activity")).toBeVisible();
    await panel.getByRole("button", { name: "展开状态", exact: true }).click();
    await expect(panel.getByRole("button", { name: "展开终端", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "展开智能体", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "查看后台任务 Dev server", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "展开终端", exact: true }).click();
    await expect(panel.getByRole("button", { name: "停止后台任务 Dev server", exact: true })).toHaveText(
      "停止",
    );
    await expect(panel.getByRole("button", { name: "查看子智能体 Inspect source", exact: true })).toHaveCount(
      0,
    );
    await panel.getByRole("button", { name: "展开智能体", exact: true }).click();
    await panel.getByRole("button", { name: "收起为胶囊", exact: true }).click();
    await expect(panel).toHaveAttribute("data-display-mode", "mini");
    await panel.getByRole("button", { name: "展开状态", exact: true }).click();
    // Each section retains its own expansion when the whole panel is collapsed.
    await expect(panel.getByRole("button", { name: "收起终端", exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "收起智能体", exact: true })).toBeVisible();
    await checkTaskMenuLayer(page, panel, "light");
    await page.mouse.move(0, 0);
    await panel.screenshot({ path: test.info().outputPath("task-panel-light.png"), animations: "disabled" });
    await expect(page.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "查看子智能体 Inspect source", exact: true }).click();
    await expect(page.locator(".subagent-pane")).toContainText("Inspecting the code");
    await page.getByRole("button", { name: "查看后台任务 Dev server", exact: true }).click();
    await expect(page.getByRole("region", { name: "后台任务输出", exact: true })).toContainText(
      "Server ready",
    );
    await page.screenshot({
      path: test.info().outputPath("task-workspace-light.png"),
      animations: "disabled",
    });
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "dark" }));
    await page.reload();
    await panel.getByRole("button", { name: "展开状态", exact: true }).click();
    await panel.getByRole("button", { name: "展开终端", exact: true }).click();
    await panel.getByRole("button", { name: "展开智能体", exact: true }).click();
    await page.mouse.move(0, 0);
    await checkTaskMenuLayer(page, panel, "dark");
    await panel.screenshot({ path: test.info().outputPath("task-panel-dark.png"), animations: "disabled" });
    await panel.getByRole("button", { name: "停止后台任务 Dev server", exact: true }).click();
    await expect(panel.getByRole("button", { name: "停止后台任务 Dev server", exact: true })).toHaveCount(0);
    await expect(panel.locator('[data-status-section="agent"]')).toContainText("1 运行");
    await expect(page.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "停止子智能体 Inspect source", exact: true }).click();
    await expect(panel).toHaveAttribute("data-running", "false");
    await expect(page.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await expect(panel).toBeVisible();
    await page.reload();
    await expect(panel.getByRole("button", { name: "展开状态", exact: true })).toHaveText("2 已结束");
    await expect(page.getByRole("button", { name: "查看任务目录", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "展开状态", exact: true }).click();
    await panel.getByRole("button", { name: "展开终端", exact: true }).click();
    await panel.getByRole("button", { name: "已结束 1", exact: true }).click();
    await expect(page.getByRole("region", { name: "任务目录", exact: true })).toContainText("Dev server");
    await editor.fill("Again");
    await editor.press("Enter");
    await expect(panel).toBeVisible();
    // Finished history remains available, and a new launch updates the same capsule.
    await panel.getByRole("button", { name: "停止后台任务 Second server", exact: true }).click();
    await expect(panel).toHaveAttribute("data-running", "false");
    await expect(panel.locator('[data-status-section="terminal"] .task-ended')).toContainText("2");
    expect(errors).toEqual([]);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});

test("terminal capsule matches ZCode and automatic layout follows the conversation width", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-terminal-status-"));
  const server = await fakeServer((body, response) => {
    const messages = body.messages as { role: string; content: string }[];
    if (messages.some((message) => message.role === "tool")) {
      send(response, chunk({ content: "Server started" }));
      done(response);
      return;
    }
    send(
      response,
      chunk({
        tool_calls: [
          {
            index: 0,
            id: "server",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: "echo 'Server ready'; sleep 120",
                description: "启动 Python HTTP 服务器",
                run_in_background: true,
              }),
            },
          },
        ],
      }),
    );
    done(response, "tool_calls");
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, url: server.url });
    const page = await app.firstWindow();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("启动一个 python server");
    await editor.press("Enter");
    await expect(page.locator("main .answer")).toContainText("Server started");
    const panel = page.getByRole("complementary", { name: "任务状态", exact: true });
    const capsule = panel.getByRole("button", { name: "展开状态", exact: true });
    const capture = async (name: string) => {
      await page.mouse.move(0, 0);
      await panel.evaluate(async (element) => {
        await Promise.all(
          element.getAnimations({ subtree: true }).map((animation) => animation.finished.catch(() => {})),
        );
      });
      const box = await panel.boundingBox();
      if (!box) throw new Error("Missing task panel");
      await page.screenshot({
        path: test.info().outputPath(name),
        animations: "disabled",
        clip: { x: box.x - 12, y: box.y - 12, width: box.width + 24, height: box.height + 24 },
      });
    };
    await expect(capsule).toHaveText("1 后台");
    await expect(panel.locator(".task-summary-icon .lucide-square-terminal")).toBeVisible();
    const capsuleGeometry = await panel.evaluate((element) => {
      const button = element.querySelector(".task-activity-toggle") as HTMLElement;
      return {
        height: element.getBoundingClientRect().height,
        innerWidth: element.clientWidth,
        buttonWidth: button.getBoundingClientRect().width,
        radius: getComputedStyle(element).borderRadius,
      };
    });
    expect(capsuleGeometry.height).toBe(34);
    expect(capsuleGeometry.radius).toBe("16px");
    expect(Math.abs(capsuleGeometry.buttonWidth - capsuleGeometry.innerWidth)).toBeLessThan(0.5);
    await capture("terminal-capsule-light.png");
    await capsule.hover();
    await expect
      .poll(() =>
        panel
          .locator(".task-summary-icon .lucide-maximize-2")
          .evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("1");
    await expect
      .poll(() =>
        panel
          .locator(".task-summary-icon .lucide-square-terminal")
          .evaluate((element) => getComputedStyle(element).opacity),
      )
      .toBe("0");
    await capsule.click();
    await expect(panel.getByRole("button", { name: "展开终端", exact: true })).toBeVisible();
    const expanded = await panel.boundingBox();
    expect(expanded?.width).toBe(320);
    expect(expanded?.height).toBe(52);
    await capture("terminal-panel-light.png");
    const elapsed = panel.locator(".task-section-summary > span").first();
    const before = await elapsed.textContent();
    await expect(elapsed).not.toHaveText(before ?? "");
    await panel.getByRole("button", { name: "展开终端", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "停止后台任务 启动 Python HTTP 服务器", exact: true }),
    ).toHaveText("停止");
    await capture("terminal-details-light.png");
    await panel.getByRole("button", { name: "收起终端", exact: true }).click();
    await expect(
      panel.getByRole("button", { name: "停止后台任务 启动 Python HTTP 服务器", exact: true }),
    ).toBeHidden();
    await panel.getByRole("button", { name: "状态面板展开策略", exact: true }).click();
    await page.getByRole("menuitemradio", { name: "自动展开", exact: true }).click();
    await expect(capsule).toBeVisible();
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1800, 900));
    await expect(panel.getByRole("button", { name: "收起为胶囊", exact: true })).toBeVisible();
    await expect(capsule).toBeHidden();
    await expect
      .poll(() =>
        page.locator(".conversation-inner").evaluate((element) => getComputedStyle(element).transform),
      )
      .toBe("matrix(1, 0, 0, 1, -168, 0)");
    await panel.getByRole("button", { name: "收起为胶囊", exact: true }).click();
    await expect(capsule).toBeVisible();
    await expect
      .poll(() =>
        page.locator(".conversation-inner").evaluate((element) => getComputedStyle(element).transform),
      )
      .toBe("none");
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1200, 800));
    await page.evaluate(() => window.zpi.updatePreferences({ theme: "dark" }));
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(capsule).toBeVisible();
    await capture("terminal-capsule-dark.png");
    await capsule.click();
    await capture("terminal-panel-dark.png");
    await panel.getByRole("button", { name: "展开终端", exact: true }).click();
    await capture("terminal-details-dark.png");
    await panel.getByRole("button", { name: "停止后台任务 启动 Python HTTP 服务器", exact: true }).click();
    await expect(panel).toHaveAttribute("data-running", "false");
    // Stopping a task must not also trigger the transparent row's open-output button.
    await expect(page.getByRole("region", { name: "后台任务输出", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "关闭任务状态", exact: true })).toHaveCount(0);
    await panel.getByRole("button", { name: "收起为胶囊", exact: true }).click();
    await expect(capsule).toHaveText("1 已结束");
    await page.reload();
    await expect(capsule).toHaveText("1 已结束");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
