import { execFile } from "node:child_process";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { searchFiles, validatedReference } from "../src/main/workspace-files.ts";
import { fixture, run } from "./helpers/context-fixture.ts";

test("file search preserves type and name ordering when relevance scores tie", async () => {
  const f = await fixture();
  for (const name of ["match-b", "match-a"]) await mkdir(join(f.workspace, name));
  for (const name of ["match-d", "match-c"]) await writeFile(join(f.workspace, name), "");
  const names = async (query: string) =>
    (await searchFiles(f.workspace, query))
      .filter(({ name }) => name.startsWith("match-"))
      .map(({ name }) => name);
  expect(await names("match")).toEqual(["match-a", "match-b", "match-c", "match-d"]);
  expect(await names("")).toEqual(["match-c", "match-d", "match-a", "match-b"]);
});

test("bounded search obeys gitignore and cwd scope; relative escapes fail but explicit absolute references work", async () => {
  const f = await fixture();
  await mkdir(join(f.workspace, "sub"));
  await writeFile(join(f.workspace, ".gitignore"), "ignored.txt\n*.log\n");
  await writeFile(join(f.workspace, "sub", ".gitignore"), "!allowed.log\n");
  await writeFile(join(f.workspace, "sub", "allowed.log"), "allowed");
  expect((await searchFiles(f.workspace, "allowed.log"))[0]).toMatchObject({ path: "sub/allowed.log" });
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
  // Absolute-path fuzzy matches may include other files from a random temp directory.
  expect((await searchFiles(f.workspace, "ignored")).map((file) => file.path)).not.toContain("ignored.txt");
  await expect(validatedReference(f.workspace, "escape.txt")).rejects.toThrow("不在");
  await expect(validatedReference(f.workspace, "../outside.txt")).rejects.toThrow("不在");
  expect(await validatedReference(f.workspace, join(f.dir, "outside.txt"))).toBe(
    await realpath(join(f.dir, "outside.txt")),
  );
  await promisify(execFile)("git", ["init"], { cwd: f.workspace });
  expect((await searchFiles(f.workspace, "ignored")).map((file) => file.path)).not.toContain("ignored.txt");
  expect(await validatedReference(f.workspace, "sub/a 中文.ts")).toBe(
    await realpath(join(f.workspace, "sub", "a 中文.ts")),
  );
});

test("absolute external Java references submit, retain their original paths and restore drafts without warnings", async () => {
  const f = await fixture();
  const folder = join(f.dir, "external project");
  await mkdir(folder);
  const path = join(folder, "BasicMetric.java");
  await writeFile(path, "class BasicMetric {}\n");
  const text = `[BasicMetric.java](<${path}>)`;
  f.host.saveDraft(f.session.id, {
    text,
    fileReferences: [path],
    selection: [text.length, text.length],
    revision: 1,
  });
  expect((await f.host.getDraft(f.session.id)).warnings).toEqual([]);
  expect(await f.host.referencedFile(f.session.id, path)).toBe(await realpath(path));
  expect(await validatedReference(f.workspace, `${folder}/`)).toBe(await realpath(folder));
  await run(f, text, { fileReferences: [path] });
  expect(JSON.stringify(f.server.requests[0])).toContain(path);
  expect(f.host.getSessionSnapshot(f.session.id).view.runs[0]).toMatchObject({
    userMessage: text,
    fileReferences: [path],
  });
  for (const invalid of ["", `${path}\0`, `${path}\n`, "x".repeat(8193)])
    await expect(validatedReference(f.workspace, invalid)).rejects.toThrow("路径无效");
  await expect(validatedReference(f.workspace, join(folder, "missing.java"))).rejects.toThrow();
});

test.each([":284", ":284:3", "#L284", "#L284-L286"])(
  "copied file links with locations (%s) validate, restore and submit without treating the suffix as a filename",
  async (suffix) => {
    const f = await fixture();
    const path = join(f.dir, "订单 %20 #1.ts");
    await writeFile(path, "export const value = 1;\n");
    const reference = `${path}${suffix}`;
    const text = `[index.ts](<${reference}>)`;
    f.host.saveDraft(f.session.id, {
      text,
      fileReferences: [reference],
      selection: [text.length, text.length],
      revision: 1,
    });
    expect(await f.host.referencedFile(f.session.id, reference)).toBe(await realpath(path));
    expect((await f.host.getDraft(f.session.id)).warnings).toEqual([]);
    await run(f, text, { fileReferences: [reference] });
    expect(f.host.getSessionSnapshot(f.session.id).view.runs[0]).toMatchObject({
      userMessage: text,
      fileReferences: [reference],
    });
    const messages = f.server.requests[0].messages as { role: string; content: string }[];
    expect(messages.findLast((message) => message.role === "user")?.content).toContain(
      `Referenced project files (read with the read tool when needed):\n- ${JSON.stringify(await realpath(path))}`,
    );
  },
);

test("line references preserve literal colon filenames and cannot bypass relative workspace boundaries", async () => {
  const f = await fixture();
  const path = join(f.workspace, "index.ts");
  await writeFile(path, "export {};\n");
  expect(await validatedReference(f.workspace, "index.ts:284:3")).toBe(await realpath(path));
  const literal = join(f.workspace, "index.ts:284");
  await writeFile(literal, "literal filename");
  expect(await validatedReference(f.workspace, "index.ts:284")).toBe(await realpath(literal));
  await writeFile(join(f.dir, "outside.ts"), "outside");
  await symlink(join(f.dir, "outside.ts"), join(f.workspace, "escape.ts"));
  for (const reference of ["../outside.ts:284", "escape.ts:284", "escape.ts#L284-L286"])
    await expect(validatedReference(f.workspace, reference)).rejects.toThrow("不在");
  for (const reference of ["index.ts:0", "index.ts:1:0", "index.ts#L4-L2", "missing.ts:284"])
    await expect(validatedReference(f.workspace, reference)).rejects.toThrow();
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
    // Exact and project-relative matches rank before incidental absolute-path fuzzy matches.
    expect((await searchFiles(f.workspace, "update")).slice(0, 4)).toMatchObject([
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
    expect((await searchFiles(f.workspace, "empty-folder"))[0]).toMatchObject({
      path: "empty-folder",
      type: "directory",
    });
    expect(
      (await searchFiles(f.workspace, "ignored-folder")).every(
        ({ path }) => path !== "ignored-folder" && !path.startsWith("ignored-folder/"),
      ),
    ).toBe(true);
    // Absolute-path fuzzy matches can include valid folders in randomly named temporary directories.
    expect(
      (await searchFiles(f.workspace, "escape-folder")).every(
        ({ path }) => path !== "escape-folder" && !path.startsWith("escape-folder/"),
      ),
    ).toBe(true);
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
