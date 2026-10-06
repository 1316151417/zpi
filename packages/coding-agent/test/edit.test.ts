import { createEditToolDefinition, createWriteToolDefinition } from "ZPI-coding-agent";
import { expect, it, vi } from "vitest";

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

it.each([
  ["first\r\nsecond\nthird\n", "first", "FIRST", "FIRST\r\nsecond\nthird\n"],
  ["first\r\nsecond\nthird\r\n", "second", "SECOND", "first\r\nSECOND\nthird\r\n"],
  ["first\r\nsecond\r\n", "first", "new\nline", "new\r\nline\r\nsecond\r\n"],
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
