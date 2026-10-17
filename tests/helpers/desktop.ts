import { appendFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { type ElectronApplication, _electron as electron } from "@playwright/test";
import { automationContract, desktopEnvironment } from "./desktop-isolation.ts";
import { electronExecutable } from "./electron-executable.ts";

const applications = new Set<ElectronApplication>();
export async function closeDesktops() {
  const results = await Promise.allSettled([...applications].map((app) => app.close()));
  const errors = results.filter((result) => result.status === "rejected").map((result) => result.reason);
  if (errors.length) throw new AggregateError(errors, "Desktop cleanup failed");
}

export async function launchDesktop({
  dir,
  url,
  project,
  images = [],
  packaged = false,
  entry,
}: {
  dir: string;
  url: string;
  project?: string;
  images?: string[];
  packaged?: boolean;
  entry?: string;
}) {
  const scope = process.env.ZPI_TEST_SCOPE;
  if (!scope || !(await realpath(dir)).startsWith(`${await realpath(scope)}${sep}`))
    throw new Error("launchDesktop requires a data directory inside the current test scope");
  const env = desktopEnvironment({
    dir,
    url,
    project,
    images,
    interactive: process.env.ZPI_TEST_INTERACTIVE === "1",
  });
  await writeFile(join(dir, ".zpi-test-owner"), automationContract);
  const executable = await electronExecutable(
    dir,
    entry ?? resolve("packages/desktop/dist/main/index.js"),
    packaged,
    env.ZPI_TEST_INTERACTIVE === "1",
  );
  const application = await electron.launch({
    ...executable,
    cwd: dir,
    env,
    timeout: 15000,
  });
  applications.add(application);
  if (process.env.ZPI_TEST_PROCESS_LOG)
    await appendFile(
      process.env.ZPI_TEST_PROCESS_LOG,
      `${JSON.stringify({ pid: application.process().pid, time: Date.now(), dir })}\n`,
    );
  const originalClose = application.close.bind(application);
  let closing: Promise<void> | undefined;
  application.close = () =>
    (closing ??= (async () => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          (async () => {
            const violations = await application
              .evaluate(() => {
                const state = (
                  globalThis as typeof globalThis & {
                    __zpiAutomation: {
                      violations: string[];
                      snapshot(): { visible: boolean; focused: boolean; focusable: boolean }[];
                    };
                  }
                ).__zpiAutomation;
                const violations = [...(state?.violations ?? [])];
                if (
                  process.env.ZPI_TEST_INTERACTIVE !== "1" &&
                  state?.snapshot().some((window) => window.visible || window.focused || window.focusable)
                )
                  violations.push("native window state escaped isolation");
                return violations;
              })
              .catch(() => []);
            await originalClose();
            if (violations.length) throw new Error(`Desktop isolation violations: ${violations.join(", ")}`);
          })(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              // The scope guardian also covers detached terminal/bash descendants.
              void originalClose().catch(() => {});
              reject(new Error("Electron cleanup exceeded 5 seconds"));
            }, 5000);
          }),
        ]);
      } finally {
        clearTimeout(timer);
        applications.delete(application);
      }
    })());
  try {
    // Main startup may still be restoring a large history before creating its window.
    // Wait in Playwright's client before evaluating in that busy V8 context.
    await application.firstWindow({ timeout: 15000 });
    const contract = await application.evaluate(
      () =>
        (
          globalThis as typeof globalThis & {
            __zpiAutomation?: { contract: string };
          }
        ).__zpiAutomation?.contract,
    );
    if (contract !== automationContract) throw new Error("Electron did not install startup isolation");
    return application;
  } catch (error) {
    await application.close().catch(() => {});
    throw error;
  }
}
