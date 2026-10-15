import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElectronApplication } from "@playwright/test";
import { chunk, done, fakeServer, send } from "../fake-server.ts";
import { runCleanup } from "../helpers/cleanup.ts";
import { launchDesktop } from "../helpers/desktop.ts";
import { expect, test } from "../helpers/test.ts";

test("default Java opening launches the associated IDE and preserves the Markdown line", async () => {
  test.skip(process.platform !== "darwin", "macOS editor launchers");
  const dir = await realpath(await mkdtemp(join(tmpdir(), "zpi-default-editor-")));
  const project = join(dir, "project");
  const bundle = join(dir, "IntelliJ IDEA.app");
  const binary = join(bundle, "Contents", "MacOS", "idea");
  const log = join(dir, "editor-args.txt");
  await mkdir(project);
  await mkdir(join(bundle, "Contents", "MacOS"), { recursive: true });
  await writeFile(binary, `#!/bin/sh\nprintf '%s\\n' "$@" > '${log}'\n`);
  await chmod(binary, 0o755);
  const filename = "订单 %20 #1.java";
  const path = join(project, filename);
  await writeFile(path, Array.from({ length: 120 }, (_, i) => `// line ${i + 1}`).join("\n"));
  const server = await fakeServer((_, response) => {
    send(response, chunk({ content: `[Java 源码](<./${encodeURIComponent(filename)}:80:3>)` }));
    done(response);
  });
  let app: ElectronApplication | undefined;
  try {
    app = await launchDesktop({ dir, project, url: server.url });
    await app.evaluate(({ app, nativeImage, shell }, bundle) => {
      app.getApplicationInfoForProtocol = async () => ({
        path: bundle,
        name: "IntelliJ IDEA",
        icon: nativeImage.createEmpty(),
      });
      const paths: string[] = [];
      Object.assign(globalThis, { defaultEditorFallbackPaths: paths });
      shell.openPath = async (path) => {
        paths.push(path);
        return "";
      };
    }, bundle);
    const page = await app.firstWindow();
    await page.getByRole("button", { name: "添加项目", exact: true }).first().click();
    await page.getByLabel("消息", { exact: true }).fill("打开 Java 文件");
    await page.getByLabel("消息", { exact: true }).press("Enter");
    await expect(page.getByTestId("run")).toHaveAttribute("data-status", "completed");
    const link = page.locator(".answer").getByRole("button", { name: "Java 源码", exact: true });
    await link.click({ button: "right" });
    await page.getByRole("menuitem", { name: "使用默认程序打开", exact: true }).click();
    await expect
      .poll(async () => (await readFile(log, "utf8").catch(() => "")).trim().split("\n"))
      .toEqual(["--line", "80", path]);
    const perform = (line?: number) =>
      page.evaluate(
        async ({ path, line }) => {
          const sessions = await window.zpi.listRecentSessions();
          if (!sessions.ok) throw new Error(sessions.error.message);
          return window.zpi.fileAction(sessions.value[0].id, path, "open", line ? { line } : undefined);
        },
        { path, line },
      );
    const result = await perform();
    expect(result.ok).toBe(true);
    await expect.poll(async () => (await readFile(log, "utf8")).trim()).toBe(path);
    const fallbackCalls = () =>
      app?.evaluate(
        () =>
          (globalThis as typeof globalThis & { defaultEditorFallbackPaths: string[] })
            .defaultEditorFallbackPaths,
      );
    expect(await fallbackCalls()).toEqual([]);
    for (const [index, mode] of ["not-executable", "exit-error", "missing"].entries()) {
      if (mode === "not-executable") await chmod(binary, 0o600);
      else if (mode === "exit-error") {
        await writeFile(binary, "#!/bin/sh\nexit 7\n");
        await chmod(binary, 0o755);
      } else await rm(binary);
      const fallback = await perform(80);
      expect(fallback.ok).toBe(true);
      expect(await fallbackCalls()).toEqual(Array(index + 1).fill(path));
    }
    await app.evaluate(({ shell }) => {
      shell.openPath = async () => "没有可用的默认应用程序";
    });
    const failed = await perform();
    expect(failed.ok).toBe(false);
    if (failed.ok) throw new Error("Expected both open methods to fail");
    expect(failed.error.message).toContain("ENOENT");
    expect(failed.error.message).toContain("没有可用的默认应用程序");
  } finally {
    await runCleanup([
      () => rm(dir, { recursive: true, force: true }),
      () => server.close(),
      () => app?.close(),
    ]);
  }
});
