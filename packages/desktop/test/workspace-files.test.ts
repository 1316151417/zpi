import { execFile } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { searchFiles, validatedReference } from "../src/main/workspace-files.ts";
import { fixture, run } from "./helpers/context-fixture.ts";

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
      type: "file",
      absolutePath: await realpath(join(f.workspace, "sub/a 中文.ts")),
    },
  ]);
  expect((await searchFiles(f.workspace, "ignored")).length).toBe(0);
  await expect(validatedReference(f.workspace, "escape.txt")).rejects.toThrow("不在");
  await expect(validatedReference(f.workspace, "../outside.txt")).rejects.toThrow("不在");
  await expect(validatedReference(f.workspace, "/etc/hosts")).rejects.toThrow("相对路径");
  await promisify(execFile)("git", ["init"], { cwd: f.workspace });
  expect((await searchFiles(f.workspace, "ignored")).length).toBe(0);
  expect(await validatedReference(f.workspace, "sub/a 中文.ts")).toBe(
    await realpath(join(f.workspace, "sub", "a 中文.ts")),
  );
});

test.each([false, true])(
  "file search includes directories, empty folders and fuzzy matches (git: %s)",
  async (git) => {
    const f = await fixture();
    if (git) await promisify(execFile)("git", ["init"], { cwd: f.workspace });
    await mkdir(join(f.workspace, "skills", "know-base-update", "references"), { recursive: true });
    await mkdir(join(f.workspace, "empty-folder"));
    await mkdir(join(f.workspace, "ignored-folder"));
    await writeFile(join(f.workspace, ".gitignore"), "ignored-folder/\n");
    await writeFile(join(f.workspace, "skills", "know-base-update", "SKILL.md"), "skill");
    await writeFile(join(f.workspace, "update.py"), "update");
    await symlink(f.dir, join(f.workspace, "escape-folder"));
    expect(await searchFiles(f.workspace, "update")).toMatchObject([
      { name: "update.py", type: "file" },
      { name: "know-base-update", type: "directory" },
      { name: "references", type: "directory" },
      { name: "SKILL.md", type: "file" },
    ]);
    expect(await searchFiles(f.workspace, "kbupd")).toContainEqual({
      name: "know-base-update",
      path: "skills/know-base-update",
      absolutePath: await realpath(join(f.workspace, "skills", "know-base-update")),
      type: "directory",
    });
    expect(await searchFiles(f.workspace, "empty-folder")).toMatchObject([{ type: "directory" }]);
    expect(await searchFiles(f.workspace, "ignored-folder")).toEqual([]);
    expect(await searchFiles(f.workspace, "escape-folder")).toEqual([]);
  },
);

test("directory references submit as paths and restore without invalid-file warnings", async () => {
  const f = await fixture();
  const folder = join(f.workspace, "资料 (draft)");
  await mkdir(folder);
  const text = `[资料 (draft)](<${folder}/>)`;
  f.host.saveDraft(f.session.id, {
    text,
    fileReferences: [],
    selection: [text.length, text.length],
    revision: 1,
  });
  expect((await f.host.getDraft(f.session.id)).warnings).toEqual([]);
  await run(f, text, { fileReferences: [`${folder}/`] });
  expect(JSON.stringify(f.server.requests[0])).toContain(`${folder}/`);
  expect(JSON.stringify(f.server.requests[0])).toContain("use bash to list folders");
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0].userMessage).toBe(text);
  await symlink(f.dir, join(f.workspace, "escape-folder"));
  await expect(f.host.referencedFile(f.session.id, "escape-folder/")).rejects.toThrow("不在");
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

test("folder previews return their type for Finder routing and preserve relative path boundaries", async () => {
  const { readFilePreview } = await import("../src/main/file-preview.ts");
  const f = await fixture();
  const folder = join(f.workspace, "资料 %20 #1");
  await mkdir(folder);
  const path = await realpath(folder);
  for (const target of ["资料 %20 #1/", folder, pathToFileURL(folder).href])
    expect(await readFilePreview(f.workspace, target)).toMatchObject({ kind: "directory", path });
  await symlink(f.dir, join(f.workspace, "escape-folder"));
  await expect(readFilePreview(f.workspace, "escape-folder")).rejects.toThrow("超出");
  await expect(readFilePreview(f.workspace, "../")).rejects.toThrow("超出");
  expect(await readFilePreview(f.workspace, f.dir)).toMatchObject({
    kind: "directory",
    path: await realpath(f.dir),
  });
});
