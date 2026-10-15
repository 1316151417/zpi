import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, join, resolve } from "node:path";
import { extractFile } from "@electron/asar";
import { automationContract } from "./desktop-isolation.ts";

const require = createRequire(import.meta.url);
export async function electronExecutable(dir: string, main: string, packaged: boolean, interactive: boolean) {
  let executablePath: string | undefined;
  let args = [main];
  if (packaged) {
    if (process.platform !== "darwin") throw new Error("Packaged tests currently require a macOS .app");
    const source = process.env.ZPI_TEST_PACKAGED_APP || resolve("release/mac-arm64/ZPI.app");
    if (
      !extractFile(
        join(source, "Contents/Resources/app.asar"),
        "packages/desktop/dist/main/index.js",
      ).includes(automationContract)
    )
      throw new Error("Packaged app lacks the current automation contract; rebuild the package first");
    const bundle = join(dir, basename(source));
    await cp(source, bundle, { recursive: true, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE });
    if (!interactive)
      execFileSync("/usr/bin/plutil", [
        "-replace",
        "LSUIElement",
        "-bool",
        "YES",
        join(bundle, "Contents/Info.plist"),
      ]);
    executablePath = join(bundle, "Contents/MacOS", basename(source, ".app"));
    args = [];
  } else {
    if (!(await readFile(main, "utf8")).includes(automationContract))
      throw new Error("Electron entry lacks the current automation contract; run npm run build first");
    if (process.platform === "darwin" && !interactive) {
      const source = require("electron") as string;
      const bundle = join(dir, "Electron.app");
      await cp(resolve(dirname(source), "../.."), bundle, {
        recursive: true,
        verbatimSymlinks: true,
        mode: constants.COPYFILE_FICLONE,
      });
      // Prevent Dock/activation during native startup, before JavaScript can set the policy.
      execFileSync("/usr/bin/plutil", [
        "-replace",
        "LSUIElement",
        "-bool",
        "YES",
        join(bundle, "Contents/Info.plist"),
      ]);
      executablePath = join(bundle, "Contents/MacOS/Electron");
      // Playwright normally adds this loader only when executablePath is omitted.
      const loader = join(
        dirname(require.resolve("playwright-core/package.json")),
        "lib/server/electron/loader.js",
      );
      args = ["-r", loader, main];
    }
  }
  return { args, ...(executablePath ? { executablePath } : {}) };
}
