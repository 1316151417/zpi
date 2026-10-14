import { readFile, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { AgentToolResult } from "zpi-agent";
import {
  createCodingTools,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  FileReadState,
} from "zpi-coding-agent";
import { temp } from "./helpers/workspace-fixture.ts";

function text(result: Pick<AgentToolResult, "content">): string {
  return result.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");
}

it("shares known contents across read, consecutive edits and writes", async () => {
  const cwd = await temp();
  const [read, , edit, write] = createCodingTools(cwd);
  const path = join(cwd, "note.md");
  await writeFile(path, "# Before\nBody\n");
  expect(text(await read.execute("first", { path: "note.md" }))).toBe("# Before\nBody\n");
  expect(text(await read.execute("repeat", { path, offset: 1 }))).toContain("File unchanged");

  await edit.execute("edit", { path, edits: [{ oldText: "Before", newText: "After" }] });
  expect(text(await read.execute("after-edit", { path }))).toContain("File unchanged");
  await edit.execute("edit-again", { path, edits: [{ oldText: "After", newText: "Final" }] });
  expect(text(await read.execute("after-next-edit", { path }))).toContain("File unchanged");
  expect(await readFile(path, "utf8")).toBe("# Final\nBody\n");

  await write.execute("write", { path: "new.md", content: "New document\n" });
  expect(text(await read.execute("after-write", { path: "new.md" }))).toContain("File unchanged");
  await write.execute("overwrite", { path, content: "Overwritten\n" });
  expect(text(await read.execute("after-overwrite", { path }))).toContain("File unchanged");
});

it("returns external changes even with the same size and modification time; tool sets are isolated", async () => {
  const cwd = await temp();
  const path = join(cwd, "note.md");
  await writeFile(path, "before\n");
  const [read] = createCodingTools(cwd);
  await read.execute("first", { path });
  const before = await stat(path);
  await writeFile(path, "AFTER!\n");
  await utimes(path, before.atime, before.mtime);
  expect(text(await read.execute("external-change", { path }))).toBe("AFTER!\n");
  expect(text(await read.execute("repeat", { path }))).toContain("File unchanged");
  const [otherRead] = createCodingTools(cwd);
  expect(text(await otherRead.execute("other-session", { path }))).toBe("AFTER!\n");
});

it("deduplicates the same range but exposes new ranges and clears ranges after edits shift lines", async () => {
  const cwd = await temp();
  const path = join(cwd, "note.md");
  await writeFile(path, "one\ntwo\nthree\n");
  const [read, , edit] = createCodingTools(cwd);
  const firstRange = { path, limit: 1 };
  expect(text(await read.execute("range", firstRange))).toContain("one\n");
  expect(text(await read.execute("repeat-range", { ...firstRange, offset: 1 }))).toContain("File unchanged");
  expect(text(await read.execute("other-range", { path, offset: 2, limit: 1 }))).toContain("two\n");

  await edit.execute("insert", { path, edits: [{ oldText: "one", newText: "first\ninserted" }] });
  expect(text(await read.execute("shifted-range", { path, offset: 2, limit: 1 }))).toContain("inserted\n");
  // A partial read followed by Edit must not hide content the model has never seen.
  expect(text(await read.execute("full", { path }))).toBe("first\ninserted\ntwo\nthree\n");
});

it.each([Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n"), "x".repeat(51 * 1024)])(
  "does not suppress truncated read results",
  async (content) => {
    const cwd = await temp();
    const path = join(cwd, "large.md");
    await writeFile(path, content);
    const [read, , edit] = createCodingTools(cwd);
    const first = await read.execute("first", { path });
    const repeat = await read.execute("repeat", { path });
    expect(first.details).toMatchObject({ truncation: { truncated: true } });
    expect(repeat.content).toEqual(first.content);
    await edit.execute("edit", { path, edits: [{ oldText: content, newText: "changed" }] });
    expect(text(await read.execute("after-edit", { path }))).not.toContain("File unchanged");
  },
);

it("does not learn contents from failed writes or reads, and keeps image reads intact", async () => {
  const fileReadState = new FileReadState();
  let content = "before";
  const operations = {
    access: async () => {},
    mkdir: async () => {},
    readFile: async () => Buffer.from(content),
    writeFile: async () => {
      throw new Error("write failed");
    },
  };
  const read = createReadToolDefinition(process.cwd(), { operations, fileReadState });
  const path = "note.md";
  await expect(read.execute("aborted", { path }, AbortSignal.abort())).rejects.toThrow("aborted");
  expect(text(await read.execute("first", { path }))).toBe("before");
  await expect(
    createWriteToolDefinition(process.cwd(), { operations, fileReadState }).execute("write", {
      path,
      content: "after",
    }),
  ).rejects.toThrow("write failed");
  await expect(
    createEditToolDefinition(process.cwd(), { operations, fileReadState }).execute("edit", {
      path,
      edits: [{ oldText: "before", newText: "after" }],
    }),
  ).rejects.toThrow("write failed");
  content = "after";
  expect(text(await read.execute("changed", { path }))).toBe("after");

  const image = createReadToolDefinition(process.cwd(), {
    operations: {
      access: async () => {},
      readFile: async () =>
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
          "base64",
        ),
      detectImageMimeType: async () => "image/png",
    },
    autoResizeImages: false,
    fileReadState,
  });
  for (const id of ["image", "image-again"]) {
    expect((await image.execute(id, { path: "image.png" })).content).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "image" })]),
    );
  }
});
