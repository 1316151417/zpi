import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export async function prepareTerminal(packageDir?: string) {
  if (process.platform !== "darwin") return;
  const root = packageDir ?? dirname(createRequire(import.meta.url).resolve("node-pty/package.json"));
  // node-pty 1.1.0 ships macOS prebuild helpers without execute permissions.
  // Fix before launching or packaging; packaged binaries must not be modified at runtime.
  for (const dir of ["build/Release", "build/Debug", "prebuilds/darwin-arm64", "prebuilds/darwin-x64"]) {
    const helper = join(root, dir, "spawn-helper");
    try {
      const info = await stat(helper);
      if ((info.mode & 0o111) !== 0o111) await chmod(helper, info.mode | 0o111);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await prepareTerminal();
