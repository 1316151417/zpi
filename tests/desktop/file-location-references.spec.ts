import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("copied links with line, column and range suffixes send and open at their original locations", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-location-reference-")));
  const project = join(dir, "project");
  const external = join(dir, "external files");
  const path = join(external, "index.ts");
  await mkdir(project);
  await mkdir(external);
  await writeFile(path, Array.from({ length: 320 }, (_, index) => `// line ${index + 1}`).join("\n"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "ok" }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    const composer = page.getByLabel("消息", { exact: true });
    const text = [
      `[行号](<${path}:284>)`,
      `[行列](<${path}:284:3>)`,
      `[锚点](<${path}#L284>)`,
      `[范围](<${path}#L284-L286>)`,
    ].join("\n");
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".error-toast")).toHaveCount(0);
    const user = page.locator(".user-message-text");
    await expect(user.locator("button.inline-mention.file")).toHaveCount(4);
    const messages = server.requests[0].messages as { role: string; content: string }[];
    expect(messages.findLast((message) => message.role === "user")?.content).toContain(
      `Referenced project files (read with the read tool when needed):\n- ${JSON.stringify(path)}`,
    );
    for (const label of ["行号", "行列", "锚点", "范围"]) {
      await user.getByRole("button", { name: label, exact: true }).click();
      await expect(page.locator(".file-text-preview")).toHaveAttribute("data-line", "284");
      if (label === "行列")
        await expect(page.locator(".file-text-preview")).toHaveAttribute("data-column", "3");
    }
    await user.getByRole("button", { name: "行列", exact: true }).click({ button: "right" });
    await page.getByRole("menuitem", { name: "复制绝对路径", exact: true }).click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(path);
    await composer.fill("[越界](<../external files/index.ts:284>)");
    await composer.press("Enter");
    await expect(page.getByRole("alert")).toContainText("引用文件不在当前工作目录内");
    await expect(page.getByTestId("run")).toHaveCount(1);
    expect(server.requests).toHaveLength(1);
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
