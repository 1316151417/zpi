// Optional macOS evidence beyond Electron's own isVisible/isFocused APIs.
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { assertBackgroundCommand } from "../tests/helpers/test-command.ts";

const args = process.argv.slice(2);
const cleanup = args[0] === "--cleanup";
if (cleanup) args.shift();
assertBackgroundCommand(args);
if (process.platform !== "darwin") throw new Error("This read-only observer requires macOS");
const directory = await mkdtemp(join(tmpdir(), "zpi-desktop-observation-"));
const executable = join(directory, "observer");
const observations = join(directory, "windows.jsonl");
const processes = join(directory, "processes.jsonl");
await writeFile(processes, "");
let observer;
let runner;
let observationStream;
let observerExit;
let runnerExit;
const forward = (signal) => runner?.kill(signal);
const interrupt = () => forward("SIGINT");
const terminate = () => forward("SIGTERM");
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  execFileSync("npm", ["run", "build"], { stdio: "inherit" });
  execFileSync("clang", [
    "-fobjc-arc",
    "-fno-modules",
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
    resolve("tests/probes/macos-desktop-observer.m"),
    "-o",
    executable,
  ]);
  observer = spawn(executable, [], { stdio: ["ignore", "pipe", "inherit"] });
  observerExit = once(observer, "exit");
  observationStream = createWriteStream(observations);
  observer.stdout.pipe(observationStream);
  runner = spawn(
    process.execPath,
    [cleanup ? "scripts/verify-test-cleanup.mjs" : "scripts/test-desktop.ts", ...args],
    {
      stdio: "inherit",
      env: { ...process.env, ZPI_TEST_PROCESS_LOG: processes },
    },
  );
  runnerExit = once(runner, "exit");
  const [code] = await runnerExit;
  observer.kill();
  await observerExit;
  await new Promise((resolve) => observationStream.end(resolve));
  const rows = (await readFile(observations, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const launches = (await readFile(processes, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const pids = new Set(launches.map((entry) => entry.pid));
  const foregroundTestSamples = rows.filter((row) => pids.has(row.front)).length;
  const visibleTestWindowSamples = rows.filter((row) => row.windowOwners.some((pid) => pids.has(pid))).length;
  const report = {
    code,
    samples: rows.length,
    launches: launches.length,
    foregroundTestSamples,
    visibleTestWindowSamples,
    // Other applications/user actions can change this counter. Never attribute every change to tests.
    clipboardCounts: [...new Set(rows.map((row) => row.clipboard))],
    observations,
    processes,
  };
  await writeFile(join(directory, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
  process.exitCode = code ?? 1;
  if (!rows.length || foregroundTestSamples || visibleTestWindowSamples) process.exitCode = 1;
} finally {
  if (runner && runner.exitCode === null && runner.signalCode === null) {
    runner.kill("SIGTERM");
    await runnerExit;
  }
  if (observer && observer.exitCode === null && observer.signalCode === null) {
    observer.kill();
    await observerExit;
  }
  observationStream?.end();
  await rm(executable, { force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
}
