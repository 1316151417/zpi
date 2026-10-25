import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { adHocInstructions } from "../src/main/memory/ad-hoc-instructions.ts";
import {
  memoryNotesDirectory,
  memoryNotesInstructions,
  memoryWorkspaceDiff,
  migrateMemoryNotes,
  prepareMemoryWorkspace,
  readMemoryNotes,
  resetMemoryBaseline,
  validateMemoryWorkspace,
} from "../src/main/memory/workspace.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "zpi-memory-notes-"));
  directories.push(root);
  await prepareMemoryWorkspace(root);
  return root;
}
const valid = "v1\n## User Profile\n\n## User preferences\n\n## General Tips\n\n## What's in Memory\n";

test("seeds the Codex ad-hoc instructions once without overwriting user edits", async () => {
  const root = await fixture();
  expect(await readFile(join(root, memoryNotesInstructions), "utf8")).toBe(adHocInstructions);
  expect(await readdir(join(root, memoryNotesDirectory))).toEqual([]);
  expect(adHocInstructions).toContain("Never delete a note file");
  expect(adHocInstructions).toContain("[ad-hoc note]");
  await writeFile(join(root, memoryNotesInstructions), "User-edited source instructions.");
  await prepareMemoryWorkspace(root);
  expect(await readFile(join(root, memoryNotesInstructions), "utf8")).toBe(
    "User-edited source instructions.",
  );
  await expect(readFile(join(root, "memory_notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
});

test("tracks independent note additions, edits and deletions against the successful Git baseline", async () => {
  const root = await fixture();
  const note = join(root, memoryNotesDirectory, "language.md");
  await writeFile(note, "Remember Chinese responses.");
  expect(await memoryWorkspaceDiff(root)).toContain("+Remember Chinese responses.");
  await resetMemoryBaseline(root);
  expect(await memoryWorkspaceDiff(root)).toBe("");
  await writeFile(note, "Correction: English responses.");
  const edit = await memoryWorkspaceDiff(root);
  expect(edit).toContain("-Remember Chinese responses.");
  expect(edit).toContain("+Correction: English responses.");
  await resetMemoryBaseline(root);
  await rm(note);
  expect(await memoryWorkspaceDiff(root)).toContain("deleted file mode");
});

test("migrates single-file requests without overwriting existing notes and retires the old inbox", async () => {
  const root = await fixture();
  const legacy = join(root, "legacy");
  await mkdir(legacy);
  const note = "Forget obsolete advice.\nPreserve this correction verbatim.\n";
  await writeFile(join(root, "memory_notes.md"), note);
  await writeFile(join(legacy, "memory_notes.md"), note);
  await writeFile(join(root, memoryNotesDirectory, "existing.md"), "User-owned note.");
  await migrateMemoryNotes(root, [legacy]);
  const inputs = await readMemoryNotes(root);
  expect(inputs.filter(({ content }) => content === note)).toHaveLength(1);
  expect(inputs.map(({ content }) => content)).toContain("User-owned note.");
  for (const directory of [root, legacy])
    await expect(readFile(join(directory, "memory_notes.md"))).rejects.toMatchObject({ code: "ENOENT" });
  await migrateMemoryNotes(root, [legacy]);
  expect(await readMemoryNotes(root)).toEqual(inputs);
});

test("a migration conflict preserves both the old file and an edited destination", async () => {
  const root = await fixture();
  const content = "Original explicit request.";
  await writeFile(join(root, "memory_notes.md"), content);
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 20);
  const target = join(root, memoryNotesDirectory, `migrated-${hash}.md`);
  await writeFile(target, "");
  await expect(migrateMemoryNotes(root)).rejects.toThrow("原文件保留");
  expect(await readFile(join(root, "memory_notes.md"), "utf8")).toBe(content);
  expect(await readFile(target, "utf8")).toBe("");
});

test.each(["edit", "delete"])("consolidation cannot %s a selected note", async (action) => {
  const root = await fixture();
  const path = join(root, memoryNotesDirectory, "request.md");
  await writeFile(path, "Explicit user correction.");
  const inputs = await readMemoryNotes(root);
  await writeFile(join(root, "memory_summary.md"), valid);
  expect(await validateMemoryWorkspace(root, inputs)).toBe(valid);
  if (action === "edit") await writeFile(path, "Changed by the background agent.");
  else await rm(path);
  await expect(validateMemoryWorkspace(root, inputs)).rejects.toThrow("修改了只读来源");
});

test("rejects symlinked note directories and files instead of following them", async () => {
  const root = await fixture();
  await symlink(join(root, memoryNotesInstructions), join(root, memoryNotesDirectory, "alias.md"));
  await expect(readMemoryNotes(root)).rejects.toThrow("符号链接");
  await rm(join(root, "extensions"), { recursive: true });
  await mkdir(join(root, "outside"));
  await symlink(join(root, "outside"), join(root, "extensions"));
  await expect(prepareMemoryWorkspace(root)).rejects.toThrow("普通目录");
  expect(await readdir(join(root, "outside"))).toEqual([]);
});
