import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("installed npm desktop includes the renderer, agent runtime and working native dependencies", async () => {
  const packageDirectory = process.env.ZPI_TEST_NPM_PACKAGE;
  test.skip(!packageDirectory, "Set ZPI_TEST_NPM_PACKAGE to a clean installation of @zpi-dev/desktop");
  if (!packageDirectory) return;
  const entry = join(packageDirectory, "dist/main/index.js");
  const dir = await mkdtemp(join(tmpdir(), "zpi-npm-package-"));
  const project = join(dir, "project");
  await mkdir(project);
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: "npm desktop works" }));
    done(response);
  });
  let application: ElectronApplication | undefined;
  try {
    application = await launchDesktop({ dir, project, url: server.url, entry });
    const page = await application.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await expect(page.getByRole("button", { name: "选择项目", exact: true })).toContainText("project");
    await page.getByLabel("消息", { exact: true }).fill("npm smoke test");
    await page.getByLabel("发送", { exact: true }).click();
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    await expect(page.locator(".answer")).toContainText("npm desktop works");
    expect(errors).toEqual([]);
    const native = await application.evaluate(
      async (_electron, { entry, project }) => {
        const require = process.getBuiltinModule("node:module").createRequire(entry);
        const image = await require("sharp")({
          create: { width: 2, height: 2, channels: 3, background: "white" },
        })
          .png()
          .toBuffer();
        const terminal: string = await new Promise((resolve, reject) => {
          const child = require("node-pty").spawn("/bin/sh", ["-c", "printf npm-terminal-ok"], {
            cwd: project,
            env: { PATH: "/usr/bin:/bin" },
          });
          let output = "";
          const timeout = setTimeout(() => {
            child.kill();
            reject(new Error("Installed npm terminal timed out"));
          }, 5000);
          child.onData((text: string) => {
            output += text;
          });
          child.onExit(() => {
            clearTimeout(timeout);
            resolve(output);
          });
        });
        return { imageBytes: image.byteLength, terminal };
      },
      { entry, project },
    );
    expect(native.imageBytes).toBeGreaterThan(0);
    expect(native.terminal).toBe("npm-terminal-ok");
  } catch (error) {
    console.error(await readFile(join(dir, "agent/logs/error.log"), "utf8").catch(() => "No error log"));
    throw error;
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => application?.close(),
    ]);
  }
});
