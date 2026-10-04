import { execFile } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { searchFiles, validatedFile } from "../src/main/workspace-files.ts";
import { fixture } from "./helpers/context-fixture.ts";

test("bounded search obeys gitignore, cwd scope and realpath; symlink escapes and cross-project paths fail", async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, "sub"));
  await writeFile(join(f.workspace, ".gitignore"), "ignored.txt\n*.log\n");
  await writeFile(join(f.workspace, "sub", ".gitignore"), "!allowed.log\n");
  await writeFile(join(f.workspace, "sub", "allowed.log"), "allowed");
  expect(await searchFiles(f.workspace, "allowed.log")).toHaveLength(1);
  await writeFile(join(f.workspace, "ignored.txt"), "ignored");
  await writeFile(join(f.workspace, "sub", "a 中文.ts"), "text");
  await writeFile(join(f.dir, "outside.txt"), "outside");
  await symlink(join(f.dir, "outside.txt"), join(f.workspace, "escape.txt"));
  expect(await searchFiles(f.workspace, "a 中文")).toEqual([
    {
      path: "sub/a 中文.ts",
      name: "a 中文.ts",
      absolutePath: await realpath(join(f.workspace, "sub/a 中文.ts")),
    },
  ]);
  expect((await searchFiles(f.workspace, "ignored")).length).toBe(0);
  await expect(validatedFile(f.workspace, "escape.txt")).rejects.toThrow("不在");
  await expect(validatedFile(f.workspace, "../outside.txt")).rejects.toThrow("不在");
  await expect(validatedFile(f.workspace, "/etc/hosts")).rejects.toThrow("相对路径");
  await promisify(execFile)("git", ["init"], { cwd: f.workspace });
  expect((await searchFiles(f.workspace, "ignored")).length).toBe(0);
  expect(await validatedFile(f.workspace, "sub/a 中文.ts")).toBe(
    await realpath(join(f.workspace, "sub", "a 中文.ts")),
  );
});

test("preview locations stay bounded across symlinks and decoded paths, with clear missing-file errors", async () => {
  const { readFilePreview } = await import("../src/main/file-preview.ts");
  const f = await fixture();
  const name = join(f.workspace, "订单 %20.json");
  await writeFile(name, '{"value":1}\n');
  const location = { line: 1, column: 3, relative: true };
  expect(await readFilePreview(f.workspace, name, location)).toMatchObject({
    path: await realpath(name),
    kind: "text",
    location,
  });
  await writeFile(join(f.dir, "outside.txt"), "outside");
  await symlink(join(f.dir, "outside.txt"), join(f.workspace, "escape.txt"));
  await expect(readFilePreview(f.workspace, join(f.workspace, "escape.txt"), location)).rejects.toThrow(
    "超出",
  );
  await expect(readFilePreview(f.workspace, "../outside.txt")).rejects.toThrow("超出");
  expect(await readFilePreview(f.workspace, join(f.dir, "outside.txt"))).toMatchObject({ kind: "text" });
  await expect(readFilePreview(f.workspace, "missing.json")).rejects.toThrow("文件不存在");
  for (const invalid of [
    { line: 0 },
    { line: 1, column: -1 },
    { column: 3 },
    { line: 4, endLine: 1 },
    { relative: "yes" },
    { unknown: 1 },
  ])
    await expect(readFilePreview(f.workspace, name, invalid)).rejects.toThrow("定位");
  expect((await f.host.previewPrompt()).prompt).toContain('::zcode-file-citation{path="path/to/file"}');
});
