import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";

test("an absolute Java link outside the task workspace can be sent, while a relative escape is rejected", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-external-reference-")));
  const project = join(dir, "project");
  const external = join(dir, "external project");
  const path = join(external, "BasicMetric.java");
  await mkdir(project);
  await mkdir(external);
  await writeFile(path, "class BasicMetric {}\n");
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
    const text = `[BasicMetric.java](<${path}>) 看看这个文件`;
    await composer.fill(text);
    await composer.press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(
      page.locator(".user-message-text").getByRole("button", { name: "BasicMetric.java", exact: true }),
    ).toBeVisible();
    await expect(page.locator(".error-toast")).toHaveCount(0);
    expect(JSON.stringify(server.requests[0].messages)).toContain(path);
    await composer.fill("[越界引用](<../external project/BasicMetric.java>)");
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
