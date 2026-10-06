import { once } from "node:events";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("task switching isolates files, terminals and browser guests and restores active/collapsed state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-pane-isolation-"));
  const project = join(dir, "project");
  await mkdir(project);
  const file = join(project, "shared.txt");
  await writeFile(file, "same file, independent previews");
  const site = createServer((request, response) => {
    response.setHeader("Content-Type", "text/html");
    response.end(`<title>Task browser</title><p>${request.url}</p><input id="draft">`);
  });
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const url = `http://127.0.0.1:${(site.address() as AddressInfo).port}`;
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[shared.txt](<${file}>)\n\n[Task browser](${url}/)` }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("task A");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await page.locator(".answer").getByRole("button", { name: "shared.txt", exact: true }).click();
    await page.getByRole("button", { name: "自动换行", exact: true }).click();
    await page.getByRole("button", { name: "新增侧栏标签", exact: true }).click();
    await page.getByRole("menuitem", { name: "终端", exact: true }).click();
    const terminal = page.locator(".right-pane .xterm-helper-textarea");
    await terminal.pressSequentially("export TASK_A_VALUE=retained; printf 'TERMINAL_A_OK\\n'", { delay: 1 });
    await terminal.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("TERMINAL_A_OK");
    await page.getByRole("button", { name: "新增侧栏标签", exact: true }).click();
    await page.getByRole("menuitem", { name: "变更", exact: true }).click();
    await page.locator(".answer").getByRole("button", { name: "Task browser", exact: true }).click();
    await expect(page.getByRole("tab", { name: "Task browser", exact: true })).toBeVisible();
    const native = async () =>
      app?.evaluate(({ BrowserWindow, WebContentsView }) =>
        BrowserWindow.getAllWindows()[0]
          .contentView.children.filter((view) => view instanceof WebContentsView)
          .map((view) => view.webContents.id),
      );
    await expect.poll(native).toHaveLength(1);
    const guestId = (await native())?.[0];
    await app.evaluate(async ({ webContents }, id) => {
      await webContents
        .fromId(id ?? -1)
        ?.executeJavaScript("document.querySelector('#draft').value = 'A browser draft'");
    }, guestId);
    await page.getByLabel("收起右侧栏", { exact: true }).click();
    await page.getByLabel("新建任务", { exact: true }).first().click();
    await editor.fill("task B");
    await editor.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect.poll(native).toEqual([]);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.locator(".pane-empty-launcher")).toBeVisible();
    await expect(page.getByRole("tablist", { name: "侧栏标签" }).getByRole("tab")).toHaveCount(0);
    await page.locator(".answer").getByRole("button", { name: "shared.txt", exact: true }).click();
    await expect(page.getByRole("tablist", { name: "侧栏标签" }).getByRole("tab")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "自动换行", exact: true })).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    await page.locator(".session-name").filter({ hasText: "task A" }).click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await expect.poll(native).toEqual([]);
    await page.getByLabel("展开右侧栏", { exact: true }).click();
    await expect(page.getByRole("tablist", { name: "侧栏标签" }).getByRole("tab")).toHaveCount(4);
    await expect(page.getByRole("tab", { name: "Task browser", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect.poll(native).toEqual([guestId]);
    expect(
      await app.evaluate(
        async ({ webContents }, id) =>
          webContents.fromId(id ?? -1)?.executeJavaScript("document.querySelector('#draft').value"),
        guestId,
      ),
    ).toBe("A browser draft");
    await page.getByRole("tab", { name: "shared.txt", exact: true }).click();
    await expect(page.getByRole("button", { name: "自动换行", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await page.getByRole("tab", { name: "zsh", exact: true }).click();
    await terminal.pressSequentially("printf 'RESTORED_%s\\n' \"$TASK_A_VALUE\"", { delay: 1 });
    await terminal.press("Enter");
    await expect(page.locator(".xterm-rows")).toContainText("RESTORED_retained");
    await page.locator(".session-name").filter({ hasText: "task B" }).click();
    await expect(page.getByRole("tab", { name: "shared.txt", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await page.getByLabel("关闭标签 shared.txt", { exact: true }).click();
    await expect(page.locator(".right-pane")).toBeHidden();
    await page.locator(".session-name").filter({ hasText: "task A" }).click();
    await expect(page.getByRole("tablist", { name: "侧栏标签" }).getByRole("tab")).toHaveCount(4);
    await expect(page.getByRole("tab", { name: "zsh", exact: true })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(errors).toEqual([]);
  } finally {
    await app?.close();
    await server.close();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
