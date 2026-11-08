import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
await mkdir(new URL("../release/npm/", import.meta.url), { recursive: true });
const child = spawn(
  "npm",
  [
    "pack",
    "--workspace=@zpi-dev/agent-sdk",
    "--workspace=@zpi-dev/desktop",
    "--pack-destination=release/npm",
  ],
  { cwd: root, stdio: "inherit" },
);
child.on("error", (error) => {
  console.error(error.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 1;
});
