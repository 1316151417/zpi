import { expect, it, vi } from "vitest";
import { createEditToolDefinition, createWriteToolDefinition } from "zpi-coding-agent";

function editable(content: string) {
  const operations = {
    access: async () => {},
    readFile: async () => Buffer.from(content),
    writeFile: vi.fn(async (_path: string, next: string) => {
      content = next;
    }),
  };
  return {
    edit: createEditToolDefinition(process.cwd(), { operations }),
    operations,
    content: () => content,
  };
}

it("omits expensive edit previews without delaying or failing the successful edit", async () => {
  const before = Array.from({ length: 8000 }, (_, i) => `old item ${i}`).join("\n");
  const after = Array.from({ length: 8000 }, (_, i) => `new item ${i}`).join("\n");
  const file = editable(before);
  const started = performance.now();
  const result = await file.edit.execute("large-edit", {
    path: "generated.txt",
    edits: [{ oldText: before, newText: after }],
  });
  expect(performance.now() - started).toBeLessThan(2000);
  expect(file.content()).toBe(after);
  expect(result.details).toMatchObject({
    diff: expect.stringContaining("omitted"),
    patch: "",
    firstChangedLine: 1,
  });
});

it.each([
  ["ababa", "aba"],
  ["aaa", "aa"],
  ["“a“a“", '"a"'],
])("rejects overlapping occurrences in %j before writing", async (content, oldText) => {
  const file = editable(content);
  await expect(
    file.edit.execute("overlap", { path: "example.txt", edits: [{ oldText, newText: "X" }] }),
  ).rejects.toThrow("2 occurrences");
  expect(file.operations.writeFile).not.toHaveBeenCalled();
  expect(file.content()).toBe(content);
});

it.each([
  ["first\r\nsecond\nthird\n", "first", "FIRST", "FIRST\r\nsecond\nthird\n"],
  ["first\r\nsecond\nthird\r\n", "second", "SECOND", "first\r\nSECOND\nthird\r\n"],
  ["first\r\nsecond\r\n", "first", "new\nline", "new\r\nline\r\nsecond\r\n"],
  ["first\rsecond\rthird\r", "second", "SECOND", "first\rSECOND\rthird\r"],
  ["first\rsecond\r", "first", "new\nline", "new\rline\rsecond\r"],
  ["first\rsecond\nthird\r\n", "first", "FIRST", "FIRST\rsecond\nthird\r\n"],
  ["\uFEFFfirst\r\n“second”  \nthird\r\n", '"second"', "SECOND", "\uFEFFfirst\r\nSECOND\nthird\r\n"],
])("edit preserves untouched line endings in %j", async (before, oldText, newText, after) => {
  const file = editable(before);
  await file.edit.execute("edit", { path: "example.txt", edits: [{ oldText, newText }] });
  expect(file.content()).toBe(after);
});

it("whitespace edits require a real match and reject multiple exact matches", async () => {
  const file = editable("x");
  await expect(
    file.edit.execute("missing", { path: "example.txt", edits: [{ oldText: "  ", newText: "added" }] }),
  ).rejects.toThrow("Could not find");
  expect(file.operations.writeFile).not.toHaveBeenCalled();
  const present = editable("x  y");
  await present.edit.execute("found", { path: "example.txt", edits: [{ oldText: "  ", newText: " " }] });
  expect(present.content()).toBe("x y");
  const multiple = editable("a  b  c");
  await expect(
    multiple.edit.execute("duplicate", { path: "example.txt", edits: [{ oldText: "  ", newText: " " }] }),
  ).rejects.toThrow("2 occurrences");
});

it.each([
  ["foo \nbar\nfoo\n", "foo ", "FOO ", "FOO \nbar\nfoo\n"],
  ['“foo”\n"foo"\n', "“foo”", "bar", 'bar\n"foo"\n'],
])("uses exact uniqueness when editing %j", async (before, oldText, newText, after) => {
  const file = editable(before);
  await file.edit.execute("exact", { path: "example.txt", edits: [{ oldText, newText }] });
  expect(file.content()).toBe(after);
});

it("successful custom writes and edits remain successful when aborted during the write", async () => {
  for (const name of ["write", "edit"] as const) {
    const controller = new AbortController();
    const written: string[] = [];
    const operations = {
      mkdir: async () => {},
      access: async () => {},
      readFile: async () => Buffer.from("before"),
      writeFile: async (_path: string, content: string) => {
        written.push(content);
        controller.abort();
      },
    };
    const result =
      name === "write"
        ? await createWriteToolDefinition(process.cwd(), { operations }).execute(
            name,
            { path: "example.txt", content: "after" },
            controller.signal,
          )
        : await createEditToolDefinition(process.cwd(), { operations }).execute(
            name,
            { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
            controller.signal,
          );
    expect(written).toEqual(["after"]);
    expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Successfully") }]);
  }
});

it("aborting before the mutation prevents both custom writes and edits", async () => {
  const operations = {
    mkdir: async () => {},
    access: async () => {},
    readFile: async () => Buffer.from("before"),
    writeFile: vi.fn(async () => {}),
  };
  const signal = AbortSignal.abort();
  await expect(
    createWriteToolDefinition(process.cwd(), { operations }).execute(
      "write",
      { path: "example.txt", content: "after" },
      signal,
    ),
  ).rejects.toThrow("Operation aborted");
  await expect(
    createEditToolDefinition(process.cwd(), { operations }).execute(
      "edit",
      { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
      signal,
    ),
  ).rejects.toThrow("Operation aborted");
  expect(operations.writeFile).not.toHaveBeenCalled();
});

it("edit preserves external changes detected before writing and allows a fresh retry", async () => {
  let content = "agent_target=old\nuser_note=before\n";
  let reads = 0;
  const operations = {
    access: async () => {},
    readFile: async () => {
      const original = Buffer.from(content);
      if (++reads === 1) content = "agent_target=old\nuser_note=USER_SAVED\n";
      return original;
    },
    writeFile: vi.fn(async (_path: string, next: string) => {
      content = next;
    }),
  };
  const edit = createEditToolDefinition(process.cwd(), { operations });
  const input = {
    path: "example.txt",
    edits: [{ oldText: "agent_target=old", newText: "agent_target=new" }],
  };
  await expect(edit.execute("conflict", input)).rejects.toThrow("File changed while preparing edits");
  expect(content).toBe("agent_target=old\nuser_note=USER_SAVED\n");
  expect(operations.writeFile).not.toHaveBeenCalled();
  await edit.execute("retry", input);
  expect(content).toBe("agent_target=new\nuser_note=USER_SAVED\n");
  expect(operations.writeFile).toHaveBeenCalledTimes(1);
});

it.each(["abort", "removed"] as const)("edit does not write when verification is %s", async (kind) => {
  const controller = new AbortController();
  let reads = 0;
  const operations = {
    access: async () => {},
    readFile: async () => {
      if (++reads === 2) {
        if (kind === "removed") throw Object.assign(new Error("File removed"), { code: "ENOENT" });
        controller.abort();
      }
      return Buffer.from("before");
    },
    writeFile: vi.fn(async () => {}),
  };
  await expect(
    createEditToolDefinition(process.cwd(), { operations }).execute(
      "edit",
      { path: "example.txt", edits: [{ oldText: "before", newText: "after" }] },
      controller.signal,
    ),
  ).rejects.toThrow(kind === "removed" ? "File removed" : "Operation aborted");
  expect(operations.writeFile).not.toHaveBeenCalled();
});
