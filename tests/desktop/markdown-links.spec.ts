import { once } from "node:events";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, deferred, done, fakeServer, send } from "../fake-server.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("Markdown links and streamed file citations share icons, preview locations and browser routing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-markdown-links-"));
  const project = join(dir, "project");
  await mkdir(project);
  const filename = "订单 %20.json",
    path = join(project, filename);
  await writeFile(path, Array.from({ length: 120 }, (_, index) => `line ${index + 1}`).join("\n"));
  await writeFile(join(project, "README.md"), "# readme");
  await writeFile(join(dir, "outside.txt"), "outside");
  await symlink(join(dir, "outside.txt"), join(project, "escape.txt"));
  const site = createServer((_, response) => response.end("<title>开发网页</title>Local page"));
  site.listen(0, "127.0.0.1");
  await once(site, "listening");
  const localUrl = `http://127.0.0.1:${(site.address() as AddressInfo).port}/page.html`;
  const partial = deferred(),
    finish = deferred();
  const model = await fakeServer(async (_, response) => {
    send(
      response,
      chunk({
        content: `网页：[开发网页](${localUrl})，https://example.com/page.html\n\n本地裸链接：${localUrl}\n\n代码：\`https://example.com/inline\`，\`README.md\`\n\n\`\`\`text\nhttps://example.com/code\n::zcode-file-citation{path="README.md"}\n\`\`\`\n\n普通文字 README.md /tmp/plain.txt\n\n[自定义标签](<./${encodeURIComponent(filename)}:80:3>) [绝对文件](<${path.replaceAll("%", "%25")}:3>) [裸文件名](README.md) [文件 URI](<${pathToFileURL(path).href}#L2-L4>) [不存在](./missing.json) [越界符号链接](./escape.txt) [不支持](javascript:alert) [越界路径](../outside.txt)\n\n[Windows](C:\\Users\\test\\.config\\a.json) [Windows 空格](<C:\\My Files\\.config\\a.json>) [Windows 定义][win]\n\n[win]: <C:\\My Files\\.config\\a&amp;b.json>\n\nWindows 引用：::zcode-file-citation{path="C:\\Users\\test\\.config\\a.json"}\n\n引用：::zcode-file-citation{path="./README`,
      }),
    );
    await partial.promise;
    send(
      response,
      chunk({ content: '.md"}\n\n`::zcode-file-citation{path="README.md"}`\n\n下一引用：::zcode-file' }),
    );
    await finish.promise;
    send(response, chunk({ content: '-citation{path="README.md"}' }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: model.url });
    await app.evaluate(({ shell }) => {
      const opened: string[] = [];
      Object.assign(globalThis, { markdownExternalUrls: opened });
      shell.openExternal = async (url) => {
        opened.push(url);
      };
    });
    const page = await app.firstWindow();
    const mainUrl = page.url();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const editor = page.getByLabel("消息", { exact: true });
    await editor.fill("链接测试");
    await editor.press("Enter");
    const answer = page.getByTestId("run").last().locator(".answer");
    await expect(answer.getByRole("button", { name: "自定义标签", exact: true })).toBeVisible();
    await expect(answer).not.toContainText('path="./README');
    await expect(answer.getByRole("button", { name: "README.md", exact: true })).toHaveCount(0);
    partial.resolve();
    await expect(answer.getByRole("button", { name: "README.md", exact: true })).toHaveCount(1);
    await expect(answer).not.toContainText("下一引用：::zcode-file");
    finish.resolve();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(answer.getByRole("button", { name: "README.md", exact: true })).toHaveCount(2);
    await expect(answer.locator("code")).toContainText([
      "https://example.com/inline",
      "README.md",
      'https://example.com/code\n::zcode-file-citation{path="README.md"}',
      '::zcode-file-citation{path="README.md"}',
    ]);
    await expect(answer.locator("code button.message-web-link, code .message-file-link")).toHaveCount(0);
    await expect(answer.getByRole("button", { name: "不支持", exact: true })).toHaveCount(0);
    await expect(answer.getByRole("button", { name: "越界路径", exact: true })).toHaveCount(0);
    await expect(answer.locator(".message-file-link")).toHaveCount(12);
    const config = answer.getByRole("button", { name: "自定义标签", exact: true });
    await expect(config).toHaveCSS("color", "rgb(0, 102, 221)");
    expect(await config.evaluate((element) => element.style.getPropertyValue("--mention-image"))).toMatch(
      /json\.svg/,
    );
    await expect(answer.getByRole("button", { name: "Windows", exact: true })).toHaveAttribute(
      "title",
      "C:/Users/test/.config/a.json",
    );
    await expect(answer.getByRole("button", { name: "a.json", exact: true })).toHaveAttribute(
      "title",
      "C:/Users/test/.config/a.json",
    );
    await expect(answer.getByRole("button", { name: "Windows 空格", exact: true })).toHaveAttribute(
      "title",
      "C:/My Files/.config/a.json",
    );
    await expect(answer.getByRole("button", { name: "Windows 定义", exact: true })).toHaveAttribute(
      "title",
      "C:/My Files/.config/a&b.json",
    );
    await config.click();
    await expect(page.getByRole("tab", { name: filename, exact: true })).toBeVisible();
    await expect(page.locator(".file-text-preview")).toHaveAttribute("data-line", "80");
    await expect(page.locator(".file-text-preview")).toHaveAttribute("data-column", "3");
    await expect(page.locator('.file-text-preview [data-line="80"]').last()).toBeInViewport();
    await expect(page.locator(".file-location")).toHaveText("第 80 行 · 第 3 列");
    await answer.getByRole("button", { name: "文件 URI", exact: true }).click();
    await expect(page.getByRole("tab", { name: filename, exact: true })).toHaveCount(1);
    await expect(page.locator(".file-text-preview")).toHaveAttribute("data-line", "2");
    await answer.getByRole("button", { name: "绝对文件", exact: true }).click();
    await expect(page.locator(".file-text-preview")).toHaveAttribute("data-line", "3");
    await answer.getByRole("button", { name: "裸文件名", exact: true }).click();
    await expect(page.getByRole("tab", { name: "README.md", exact: true })).toBeVisible();
    const external = () =>
      app?.evaluate(
        () => (globalThis as typeof globalThis & { markdownExternalUrls: string[] }).markdownExternalUrls,
      );
    await answer.getByRole("button", { name: "https://example.com/page.html", exact: true }).click();
    await expect.poll(external).toEqual(["https://example.com/page.html"]);
    const local = answer.getByRole("button", { name: "开发网页", exact: true });
    await answer.getByRole("button", { name: localUrl, exact: true }).click();
    await expect(page.getByLabel("浏览器地址").last()).toHaveValue(localUrl);
    await local.click();
    await expect(page.getByLabel("浏览器地址").last()).toHaveValue(localUrl);
    await local.click({ modifiers: ["Meta"] });
    await expect.poll(external).toEqual(["https://example.com/page.html", localUrl]);
    await local.click({ button: "right" });
    await page.getByRole("menuitem", { name: "在浏览器中打开", exact: true }).click();
    await expect.poll(external).toEqual(["https://example.com/page.html", localUrl, localUrl]);
    const publicLink = answer.getByRole("button", { name: "https://example.com/page.html", exact: true });
    await publicLink.click({ button: "right" });
    await page.getByRole("menuitem", { name: "打开", exact: true }).click();
    await expect(page.getByLabel("浏览器地址").last()).toHaveValue("https://example.com/page.html");
    // macOS maps native Ctrl-click to the context menu; exercise its click-event modifier separately.
    await local.dispatchEvent("click", { ctrlKey: true });
    await expect.poll(external).toEqual(["https://example.com/page.html", localUrl, localUrl, localUrl]);
    await answer.getByRole("button", { name: "不存在", exact: true }).click();
    await expect(page.getByText(/文件不存在：/).first()).toBeVisible();
    await answer.getByRole("button", { name: "越界符号链接", exact: true }).click();
    await expect(page.getByText(/相对文件链接超出当前工作目录/).first()).toBeVisible();
    expect(page.url()).toBe(mainUrl);
    expect(errors).toEqual([]);
    expect(JSON.stringify(model.requests[0].messages)).toContain("::zcode-file-citation");
    expect(JSON.stringify(model.requests[0].messages)).toContain(
      "return local file references as Markdown links",
    );
    expect(JSON.stringify(model.requests[0].messages)).toContain("Return web URLs as Markdown links");
    await page.screenshot({ path: "test-results/desktop-markdown-links.png" });
  } finally {
    partial.resolve();
    finish.resolve();
    await app?.close();
    await model.close();
    site.closeAllConnections();
    await new Promise<void>((resolve) => site.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});
