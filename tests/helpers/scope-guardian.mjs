// Independent of the Playwright worker: EOF also arrives after a crash/SIGKILL.
// Only descendants observed under that worker are owned; never kill by name or old PID alone.
import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { processSnapshot as snapshot } from "./process-snapshot.ts";

const execute = promisify(execFile);
const root = process.argv[2];
const owner = Number(process.argv[3]);
const owned = new Map();
let stopping = false;
let snapshotPending;
let ownerBorn;
async function collect() {
  const processes = await snapshot();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, info] of processes) {
      if (pid === process.pid || pid === owner || owned.has(pid)) continue;
      const parent = processes.get(info.parent);
      if (
        (info.parent === owner && processes.get(owner)?.born === ownerBorn) ||
        (parent && owned.get(info.parent) === parent.born)
      ) {
        owned.set(pid, info.born);
        changed = true;
      }
    }
  }
  return processes;
}
async function signal(kind) {
  const processes = await collect();
  for (const [pid, born] of [...owned].reverse()) {
    if (processes.get(pid)?.born !== born) continue;
    try {
      if (process.platform === "win32")
        await execute("taskkill", ["/PID", String(pid), "/F"], { windowsHide: true });
      else process.kill(pid, kind);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
async function finish() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  try {
    await snapshotPending;
    await signal("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
    await signal("SIGKILL");
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    process.exit(0);
  } catch (error) {
    console.error("Test scope cleanup failed:", error);
    process.exit(1);
  }
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  if (line === "close") void finish();
});
input.on("close", () => void finish());
const timer = setInterval(() => {
  if (!snapshotPending)
    snapshotPending = collect()
      .catch((error) => {
        console.error(error);
        process.exitCode = 1;
      })
      .finally(() => {
        snapshotPending = undefined;
      });
}, 100);
ownerBorn = (await snapshot()).get(owner)?.born;
if (!ownerBorn) throw new Error("Test scope owner disappeared");
await collect();
console.log("ready");
