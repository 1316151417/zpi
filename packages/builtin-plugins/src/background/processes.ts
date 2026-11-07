// ZCode Bash gives process trees 1500 ms to handle SIGTERM before escalating.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { killProcessTree } from "zpi-coding-agent";

export function processGroupAlive(pid: number | undefined) {
  if (!pid || process.platform === "win32") return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
export async function terminateTaskProcess(pid: number) {
  if (process.platform === "win32") {
    killProcessTree(pid);
    return;
  }
  const descendants = new Set<number>();
  try {
    const { stdout } = await promisify(execFile)("ps", ["-A", "-o", "pid=", "-o", "ppid="], {
      timeout: 500,
      maxBuffer: 4 * 1024 ** 2,
    });
    const children = new Map<number, number[]>();
    for (const line of stdout.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s*$/.exec(line);
      if (!match) continue;
      const child = Number(match[1]),
        parent = Number(match[2]);
      children.set(parent, [...(children.get(parent) ?? []), child]);
    }
    const pending = [pid];
    while (pending.length)
      for (const child of children.get(pending.pop() as number) ?? []) {
        if (child <= 1 || child === pid || descendants.has(child)) continue;
        descendants.add(child);
        pending.push(child);
      }
  } catch {
    /* Process group signaling still works if ps is unavailable. */
  }
  const signal = (target: number, kind: NodeJS.Signals) => {
    try {
      process.kill(target, kind);
    } catch {
      /* Already exited. */
    }
  };
  const anyAlive = () =>
    processGroupAlive(pid) ||
    [...descendants].some((child) => {
      try {
        process.kill(child, 0);
        return true;
      } catch {
        return false;
      }
    });
  signal(-pid, "SIGTERM");
  for (const child of descendants) signal(child, "SIGTERM");
  const deadline = Date.now() + 1500;
  while (anyAlive() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
  if (processGroupAlive(pid)) signal(-pid, "SIGKILL");
  for (const child of descendants) signal(child, "SIGKILL");
}
