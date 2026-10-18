import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

/** Read-only WindowServer metadata; no pixels, titles, clipboard or input. */
export async function nativeWindowOrder(directory: string, pids: (number | undefined)[]) {
  const execute = promisify(execFile);
  const path = join(directory, "window-order");
  await execute("clang", [
    "-fobjc-arc",
    "-framework",
    "AppKit",
    "-framework",
    "CoreGraphics",
    resolve("tests/probes/macos-desktop-observer.m"),
    "-o",
    path,
  ]);
  return async () => {
    const record = JSON.parse((await execute(path, ["--once"])).stdout) as {
      front: number;
      details: { pid: number; layer: number }[];
    };
    return {
      front: pids.includes(record.front) ? record.front : 0,
      details: record.details.filter((window) => pids.includes(window.pid)),
    };
  };
}
