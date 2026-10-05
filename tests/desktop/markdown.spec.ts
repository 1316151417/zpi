import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("streaming code, formulas and Mermaid follow both themes; IPC copy reports success and failure without browser clipboard", async () => {
  test.setTimeout(60000);
  const dir = await mkdtemp(join(tmpdir(), "zpi-markdown-")),
    project = join(dir, "project");
  await mkdir(project);
  const reasoning = deferred();
  const first = deferred(),
    second = deferred();
  const server = await fakeServer(async (body, r) => {
    const messages = body.messages as unknown as { role: string; content: string }[];
    if (messages.some((message) => message.role === "user" && message.content === "tool error")) {
      if (messages.at(-1)?.role === "tool") {
        send(r, chunk({ content: "Tool error handled" }));
        done(r);
      } else {
        send(
          r,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "failed-read",
                type: "function",
                function: { name: "read", arguments: JSON.stringify({ path: "missing.txt" }) },
              },
            ],
          }),
        );
        done(r, "tool_calls");
      }
      return;
    }
    send(r, chunk({ reasoning_content: "Reasoning line one\nline two" }));
    await reasoning.promise;
    send(r, chunk({ content: "## Markdown\n\n```typescript\nconst value = 1;\n" }));
    await first.promise;
    send(
      r,
      chunk({
        content: "```\n\n$$\nx^2 + y^2 = z^2\n$$\n\n```mermaid\nflowchart LR\n  A[Start] --> B[End]\n",
      }),
    );
    await second.promise;
    send(r, chunk({ content: "```\n" }));
    done(r);
  });
  let app = await launchDesktop({ dir, project, url: server.url });
  const clipboard = await app.evaluate(({ clipboard }) => ({
    text: clipboard.readText(),
    html: clipboard.readHTML(),
    rtf: clipboard.readRTF(),
    image: Array.from(clipboard.readImage().toPNG()),
  }));
  try {
    const page = await app.firstWindow(),
      errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.emulateMedia({ colorScheme: "light" });
    await page.evaluate(() => {
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw Error("Browser clipboard is blocked");
          },
        },
        configurable: true,
      });
    });
    await app.evaluate(({ clipboard }) => {
      const original = clipboard.writeText;
      let fail = false;
      Object.assign(globalThis, {
        setCopyFailure: (value: boolean) => {
          fail = value;
        },
      });
      clipboard.writeText = (text: string) => {
        if (fail) throw Error("Clipboard unavailable");
        original.call(clipboard, text);
      };
    });
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("render markdown");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    const thought = page.getByTestId("thinking-block");
    await expect(thought).toContainText("正在思考");
    await thought.getByRole("button").click();
    await expect(thought.locator(".thinking-body")).toBeVisible();
    reasoning.resolve();
    const code = page.locator('[data-streamdown="code-block"]').first();
    await expect(code).toHaveAttribute("data-incomplete", "true");
    await expect(code.getByRole("button", { name: "复制代码", exact: true })).toBeDisabled();
    first.resolve();
    await expect(page.locator(".katex").first()).toBeVisible();
    await expect(page.locator('[data-streamdown="mermaid-block"]')).toBeVisible();
    await expect(
      page.locator('[data-streamdown="mermaid-block"] svg[aria-roledescription="flowchart-v2"]'),
    ).toHaveCount(0);
    second.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(
      page.locator('[data-streamdown="mermaid-block"] svg[aria-roledescription="flowchart-v2"]'),
    ).toBeVisible();
    const keyword = code
      .locator("code span")
      .filter({ hasText: /^const$/ })
      .first();
    await expect(keyword).toBeVisible();
    const lightColor = await keyword.evaluate((el) => getComputedStyle(el).color);
    const lightBackground = await code.evaluate((el) => getComputedStyle(el).backgroundColor);
    const lightFill = await page
      .locator('[data-streamdown="mermaid-block"] svg .node rect')
      .first()
      .evaluate((el) => getComputedStyle(el).fill);
    await code.getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(code.getByRole("status")).toHaveText("已复制");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("const value = 1;\n");
    await expect(code.getByRole("button", { name: "复制代码", exact: true })).toBeVisible();
    await app.evaluate(() => {
      (globalThis as unknown as { setCopyFailure(value: boolean): void }).setCopyFailure(true);
    });
    await code.getByRole("button", { name: "复制代码", exact: true }).click();
    await expect(code.getByRole("alert")).toHaveText("复制失败，点击重试");
    await app.evaluate(() => {
      (globalThis as unknown as { setCopyFailure(value: boolean): void }).setCopyFailure(false);
    });
    await code.getByRole("button", { name: "复制失败，点击重试", exact: true }).click();
    await expect(code.getByRole("status")).toHaveText("已复制");
    const rejected = await page.evaluate(async () => [
      await window.zpi.copyText(12 as never),
      await window.zpi.copyText("x".repeat(2 * 1024 * 1024 + 1)),
    ]);
    expect(rejected.every((result) => !result.ok)).toBe(true);
    await page.getByTestId("progress").click();
    await expect(thought).toBeVisible();
    await expect(thought.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    await expect(thought.locator(".reasoning-duration")).toHaveText(/\d+ 秒/);
    await expect(thought.locator(".thinking-body")).toBeVisible();
    await page.screenshot({ path: "test-results/desktop-markdown-light.png" });
    await page.emulateMedia({ colorScheme: "dark" });
    await expect.poll(() => keyword.evaluate((el) => getComputedStyle(el).color)).not.toBe(lightColor);
    await expect
      .poll(() => code.evaluate((el) => getComputedStyle(el).backgroundColor))
      .not.toBe(lightBackground);
    await expect
      .poll(() =>
        page
          .locator('[data-streamdown="mermaid-block"] svg .node rect')
          .first()
          .evaluate((el) => getComputedStyle(el).fill),
      )
      .not.toBe(lightFill);
    await expect(page.locator(".katex").first()).toBeVisible();
    await page.screenshot({ path: "test-results/desktop-markdown-dark.png" });
    // Fixed modes override OS preference; all rendered content uses the same root theme.
    await page.getByRole("button", { name: "设置", exact: true }).click();
    const settings = page.getByRole("region", { name: "设置", exact: true });
    await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.screenshot({ path: "test-results/desktop-appearance-theme-menu.png" });
    await page.getByRole("option", { name: "浅色", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("light");
    await settings.getByRole("spinbutton", { name: "界面字号", exact: true }).fill("12");
    await settings.getByRole("spinbutton", { name: "界面字号", exact: true }).press("Enter");
    await expect
      .poll(() =>
        page
          .locator(".markdown-body")
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
      )
      .toBe("12px");
    await expect(page.locator("html")).toHaveCSS("font-size", "16px");
    await settings.getByRole("spinbutton", { name: "界面字号", exact: true }).fill("16");
    await settings.getByRole("spinbutton", { name: "界面字号", exact: true }).press("Enter");
    await expect
      .poll(() =>
        page
          .locator(".markdown-body")
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
      )
      .toBe("16px");
    await settings.getByLabel("关闭设置").click();
    await expect.poll(() => keyword.evaluate((el) => getComputedStyle(el).color)).toBe(lightColor);
    await expect
      .poll(() =>
        page
          .locator('[data-streamdown="mermaid-block"] svg .node rect')
          .first()
          .evaluate((el) => getComputedStyle(el).fill),
      )
      .toBe(lightFill);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.emulateMedia({ colorScheme: "light" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "系统", exact: true }).click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.emulateMedia({ colorScheme: "dark" });
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await settings.getByRole("combobox", { name: "界面主题", exact: true }).click();
    await page.getByRole("option", { name: "深色", exact: true }).click();
    await page.screenshot({ path: "test-results/appearance-dark-large.png" });
    await settings.getByLabel("关闭设置").click();
    await page.getByLabel("消息", { exact: true }).fill("tool error");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveCount(2);
    await expect(page.getByTestId("run").last()).toHaveAttribute("data-status", "completed");
    await page.getByTestId("progress").last().click();
    await page.getByLabel("工具执行失败").hover();
    const errorText = page.locator(".tool-error-tooltip > .tool-error-content");
    await expect(errorText).toContainText("missing.txt");
    const fullError = await errorText.innerText();
    await page.locator(".tool-error-tooltip > .tool-error-copy").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(fullError);
    await page.screenshot({ path: "test-results/tool-failure-dark.png" });
    expect(errors).toEqual([]);
    await app.close();
    app = await launchDesktop({ dir, project, url: server.url });
    const restarted = await app.firstWindow();
    await expect(restarted.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect
      .poll(() =>
        restarted
          .locator(".markdown-body")
          .first()
          .evaluate((el) => getComputedStyle(el).fontSize),
      )
      .toBe("16px");
    expect(await app.evaluate(({ nativeTheme }) => nativeTheme.themeSource)).toBe("dark");
    await restarted.getByTestId("progress").first().click();
    await expect(restarted.getByTestId("thinking-block").locator(".reasoning-duration")).toHaveCount(0);
  } finally {
    reasoning.resolve();
    first.resolve();
    second.resolve();
    await app.evaluate(
      ({ clipboard, nativeImage }, old) =>
        clipboard.write({
          text: old.text,
          html: old.html,
          rtf: old.rtf,
          ...(old.image.length ? { image: nativeImage.createFromBuffer(Buffer.from(old.image)) } : {}),
        }),
      clipboard,
    );
    await app.close();
    await server.close();
    await rm(dir, { recursive: true, force: true });
  }
});
