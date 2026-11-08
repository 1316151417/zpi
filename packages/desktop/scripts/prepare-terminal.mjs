import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

// node-pty's macOS prebuilt spawn helper needs execute permission after installation.
if (process.platform === "darwin") {
  const root = dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  for (const directory of [
    "build/Release",
    "build/Debug",
    "prebuilds/darwin-arm64",
    "prebuilds/darwin-x64",
  ]) {
    const path = join(root, directory, "spawn-helper");
    try {
      const info = await stat(path);
      if ((info.mode & 0o111) !== 0o111) await chmod(path, info.mode | 0o111);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}
