import { closeSync, fsyncSync, openSync } from "node:fs";

export function syncDirectory(path: string): void {
  // Windows does not expose directory fsync through Node's file API.
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
