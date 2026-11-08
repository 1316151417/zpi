import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

const launcher = new URL("../bin/cli.mjs", import.meta.url);

test("npm launcher reports help and version without starting Electron", () => {
  const version = spawnSync(process.execPath, [launcher.pathname, "--version"], { encoding: "utf8" });
  expect(version.status).toBe(0);
  expect(version.stdout.trim()).toBe(
    JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
  );
  const help = spawnSync(process.execPath, [launcher.pathname, "--help"], { encoding: "utf8" });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("Usage: zpi-desktop");
});

test("npm launcher forwards arguments and exit status, clears Node mode and selects ZPI data", async () => {
  const directory = await mkdtemp(join(tmpdir(), "zpi-npm-launcher-"));
  try {
    await mkdir(join(directory, "bin"));
    await mkdir(join(directory, "dist/main"), { recursive: true });
    await mkdir(join(directory, "node_modules/electron"), { recursive: true });
    await cp(launcher, join(directory, "bin/cli.mjs"));
    await writeFile(join(directory, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(join(directory, "node_modules/electron/index.js"), "module.exports = process.execPath;");
    await writeFile(
      join(directory, "dist/main/index.js"),
      `console.log(JSON.stringify({args: process.argv.slice(2), npm: process.env.ZPI_NPM_LAUNCH, node: process.env.ELECTRON_RUN_AS_NODE ?? null, cwd: process.cwd()})); process.exit(7);`,
    );
    const result = spawnSync(process.execPath, [join(directory, "bin/cli.mjs"), "forwarded"], {
      cwd: directory,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
      encoding: "utf8",
    });
    expect(result.status).toBe(7);
    expect(JSON.parse(result.stdout)).toEqual({ args: ["forwarded"], npm: "1", node: null, cwd: directory });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
