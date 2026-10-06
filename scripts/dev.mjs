import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import electron from "electron";
import { build } from "tsup";
import { createServer } from "vite";
import { buildAppIcon } from "./app-icon.mjs";
import { mainBuild, preloadBuild } from "./desktop-build.mjs";

await buildAppIcon();
let executable = electron;
if (process.platform === "darwin") {
  // Give the development app its own Dock name without modifying the installed Electron bundle.
  const bundle = resolve("node_modules/.cache/zpi-dev/ZPI.app");
  await cp(resolve(dirname(electron), "../.."), bundle, {
    recursive: true,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const plist = join(bundle, "Contents/Info.plist");
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    execFileSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} ZPI`, plist]);
  }
  executable = join(bundle, "Contents/MacOS/Electron");
}
let child;
let shuttingDown = false;
const server = await createServer({
  configFile: "packages/desktop/vite.config.ts",
  ...(process.env.ZPI_DEV_PORT ? { server: { port: Number(process.env.ZPI_DEV_PORT) } } : {}),
});
await server.listen();
const devUrl = server.resolvedUrls?.local[0];
if (!devUrl) throw new Error("Vite did not expose a local URL");
async function stopDesktop() {
  if (!child || child.exitCode !== null) return;
  const current = child;
  await new Promise((resolve) => {
    current.once("exit", resolve);
    current.kill("SIGTERM");
  });
}
await build({
  ...mainBuild,
  watch: [
    "packages/desktop/src/main",
    "packages/desktop/src/shared",
    "packages/desktop/src/preload",
    "packages/ai/src",
    "packages/agent/src",
    "packages/coding-agent/src",
  ],
  onSuccess: async () => {
    if (shuttingDown) return;
    await build(preloadBuild);
    await stopDesktop();
    if (shuttingDown) return;
    const env = { ...process.env, ZPI_DEV_URL: devUrl };
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawn(
      executable,
      [
        "--enable-source-maps",
        ...(process.env.ZPI_DEV_DEBUG === "1" ? ["--remote-debugging-port=0"] : []),
        "packages/desktop/dist/main/index.js",
      ],
      { stdio: "inherit", env },
    );
    console.log("ZPI Desktop started. Ctrl+C stops the app and development server.");
  },
});
async function close() {
  if (shuttingDown) return;
  shuttingDown = true;
  await stopDesktop();
  await server.close();
  process.exit(0);
}
process.on("SIGINT", close);
process.on("SIGTERM", close);
