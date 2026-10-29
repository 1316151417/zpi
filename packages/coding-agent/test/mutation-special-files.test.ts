import { spawnSync } from "node:child_process";
import { lstat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { directory } from "./helpers/session-fixture.ts";

test.skipIf(process.platform === "win32").each([
  ["definition", false],
  ["definition", true],
  ["edit", false],
  ["edit", true],
  ["write", false],
  ["write", true],
] as const)("%s rejects a FIFO without waiting for a writer (symlink=%s)", async (tool, alias) => {
  const cwd = await directory();
  const fifo = join(cwd, "build.pipe");
  expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
  const path = alias ? join(cwd, "alias") : fifo;
  if (alias) await symlink(fifo, path);
  const source = new URL("../src/core/tools/index.ts", import.meta.url).href;
  // Isolate the blocking regression: on failure only this child is terminated, not a test worker's fs pool.
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { createEditToolDefinition, createEditTool, createWriteTool } from ${JSON.stringify(source)};
    const [cwd, path, name] = process.argv.slice(1);
    const tool = name === "definition" ? createEditToolDefinition(cwd)
      : name === "edit" ? createEditTool(cwd) : createWriteTool(cwd);
    try {
      await tool.execute("special-file", { path, content: "new", edits: [{ oldText: "old", newText: "new" }] });
      console.log("unexpected success");
    } catch (error) { console.log(error.message); }
  `,
      cwd,
      path,
      tool,
    ],
    { timeout: 3000, encoding: "utf8" },
  );
  expect(child.error, child.stderr).toBeUndefined();
  expect(child.status, child.stderr).toBe(0);
  expect(child.stdout).toContain("requires a regular file");
  expect((await lstat(fifo)).isFIFO()).toBe(true);
});
