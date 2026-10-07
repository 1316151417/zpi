import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { prepareTerminal } from "../../../scripts/prepare-terminal.ts";

it.skipIf(process.platform !== "darwin")(
  "repairs macOS terminal helpers for both architectures and rebuilt binaries before packaging",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ZPI-terminal-setup-"));
    try {
      const helpers = ["prebuilds/darwin-arm64", "prebuilds/darwin-x64", "build/Release"];
      for (const dir of helpers) {
        await mkdir(join(root, dir), { recursive: true });
        const path = join(root, dir, "spawn-helper");
        await writeFile(path, "helper");
        await chmod(path, 0o644);
      }
      const native = join(root, "prebuilds/darwin-arm64/pty.node");
      await writeFile(native, "native module");
      await chmod(native, 0o644);
      await prepareTerminal(root);
      await prepareTerminal(root);
      for (const dir of helpers) {
        expect((await stat(join(root, dir, "spawn-helper"))).mode & 0o777).toBe(0o755);
      }
      expect((await stat(native)).mode & 0o777).toBe(0o644);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform !== "darwin")(
  "surfaces terminal setup failures instead of ignoring them",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ZPI-terminal-setup-error-"));
    try {
      const file = join(root, "not-a-directory");
      await writeFile(file, "file");
      await expect(prepareTerminal(file)).rejects.toMatchObject({ code: "ENOTDIR" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
