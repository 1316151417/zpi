import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runCleanup } from "./cleanup.ts";
import { closeDesktops } from "./desktop.ts";

export async function desktopScope({ interactive = false } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zpi-desktop-scope-")));
  const original = new Map(
    ["TMPDIR", "TMP", "TEMP", "ZPI_TEST_SCOPE", "ZPI_TEST_INTERACTIVE"].map((key) => [key, process.env[key]]),
  );
  const guardian = spawn(
    process.execPath,
    [fileURLToPath(new URL("./scope-guardian.mjs", import.meta.url)), root, String(process.pid)],
    {
      stdio: ["pipe", "pipe", "inherit"],
      detached: true,
      windowsHide: true,
    },
  );
  const exited = once(guardian, "exit");
  try {
    await Promise.race([
      once(guardian.stdout, "data"),
      exited.then(() => {
        throw new Error("Test cleanup guardian failed to start");
      }),
    ]);
    for (const key of ["TMPDIR", "TMP", "TEMP", "ZPI_TEST_SCOPE"]) process.env[key] = root;
    process.env.ZPI_TEST_INTERACTIVE = interactive ? "1" : "0";
  } catch (error) {
    guardian.stdin.end();
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return {
    root,
    async close() {
      await runCleanup([
        async () => {
          guardian.stdin.end("close\n");
          const [code] = await exited;
          for (const [key, value] of original) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
          }
          if (code !== 0) throw new Error(`Test scope guardian failed: ${code}`);
        },
        closeDesktops,
      ]);
    },
  };
}
