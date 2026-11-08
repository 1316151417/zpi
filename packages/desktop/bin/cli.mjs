#!/usr/bin/env node
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--version") || args.includes("-v")) {
  console.log(JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
} else if (args.includes("--help") || args.includes("-h")) {
  console.log("Usage: zpi-desktop [--version] [--help]\n\nStart the ZPI desktop workspace.");
} else {
  if (process.platform === "win32") {
    console.error("zpi-desktop does not support Windows. The Agent SDK remains cross-platform.");
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  const env = { ...process.env, ZPI_NPM_LAUNCH: "1" };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(
    require("electron"),
    [fileURLToPath(new URL("../dist/main/index.js", import.meta.url)), ...args],
    { env, stdio: "inherit" },
  );
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM"])
    process.on(signal, () => {
      if (!stopping) {
        stopping = true;
        child.kill(signal);
      }
    });
  child.on("error", (error) => {
    console.error(`zpi-desktop: ${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code) => {
    process.exitCode = stopping ? 0 : (code ?? 1);
  });
}
