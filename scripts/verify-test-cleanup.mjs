// Intentionally failing child suites verify the real Playwright fixture and worker-death path.
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { processSnapshot } from "../tests/helpers/process-snapshot.ts";
import { assertBackgroundCommand } from "../tests/helpers/test-command.ts";
import safetyCheck from "../tests/safety-check.ts";

assertBackgroundCommand(process.argv.slice(2));
process.env.PLAYWRIGHT_HTML_OPEN = "never";
await safetyCheck();
const root = await mkdtemp(join(tmpdir(), "zpi-cleanup-validation-"));
let currentChild;
let interrupted = false;
const interrupt = () => {
  interrupted = true;
  currentChild?.kill("SIGINT");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function poll(read, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Cleanup probe timed out");
}
try {
  for (const mode of ["normal", "failure", "timeout", "cancel", "crash"]) {
    if (interrupted) throw new Error("Cleanup verification interrupted");
    const report = join(root, `${mode}.json`);
    const child = spawn(
      process.execPath,
      [resolve("node_modules/@playwright/test/cli.js"), "test", "--config=tests/probes/playwright.config.ts"],
      {
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, ZPI_CLEANUP_REPORT: report, ZPI_CLEANUP_PROBE: mode },
      },
    );
    currentChild = child;
    let output = "";
    child.stdout.on("data", (data) => {
      output += data;
    });
    child.stderr.on("data", (data) => {
      output += data;
    });
    const exited = once(child, "exit");
    try {
      const info = await poll(async () => {
        if (interrupted || child.exitCode !== null || child.signalCode !== null) throw new Error(output);
        return JSON.parse(await readFile(report, "utf8").catch(() => "null"));
      });
      if (mode === "cancel") child.kill("SIGINT");
      if (mode === "crash") process.kill(info.worker, "SIGKILL");
      const [code] = await exited;
      if ((mode === "normal") !== (code === 0)) throw new Error(`Unexpected ${mode} exit ${code}: ${output}`);
      await poll(async () => {
        const current = await processSnapshot();
        return (
          !alive(info.electron) &&
          info.descendants.every(([pid, identity]) => current.get(pid)?.born !== identity.born) &&
          (await access(info.scope).then(
            () => false,
            () => true,
          ))
        );
      }, 15000);
      console.log(
        `${mode}: expected runner exit ${code}; Electron and ${info.descendants.length} recorded descendants exited; owned scope removed`,
      );
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await exited;
      }
      currentChild = undefined;
    }
  }
} finally {
  await rm(root, { recursive: true, force: true });
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
}
