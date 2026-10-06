import { createReadToolDefinition } from "ZPI-coding-agent";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";

it("read rejects invalid line numbers before accessing files, including direct SDK calls", async () => {
  const operations = {
    access: vi.fn(async () => {}),
    readFile: vi.fn(async () => Buffer.from("one\ntwo\nthree\nfour")),
  };
  const read = createReadToolDefinition(process.cwd(), { operations });
  for (const name of ["offset", "limit"] as const) {
    for (const value of [-1, 0, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      const args = { path: "example.txt", [name]: value };
      expect(Check(read.parameters, args)).toBe(false);
      await expect(read.execute("invalid", args)).rejects.toThrow(`${name} must be a positive integer`);
    }
  }
  expect(operations.access).not.toHaveBeenCalled();
  expect(operations.readFile).not.toHaveBeenCalled();
});

it("read uses one-based integer offsets and gives a continuation that reads the remaining lines", async () => {
  const read = createReadToolDefinition(process.cwd(), {
    operations: {
      access: async () => {},
      readFile: async () => Buffer.from("one\ntwo\nthree\nfour"),
    },
  });
  expect((await read.execute("all", { path: "example.txt" })).content).toEqual([
    { type: "text", text: "one\ntwo\nthree\nfour" },
  ]);
  expect((await read.execute("part", { path: "example.txt", offset: 2, limit: 2 })).content).toEqual([
    { type: "text", text: "two\nthree\n\n[1 more lines in file. Use offset=4 to continue.]" },
  ]);
  expect((await read.execute("rest", { path: "example.txt", offset: 4 })).content).toEqual([
    { type: "text", text: "four" },
  ]);
  await expect(read.execute("past-end", { path: "example.txt", offset: 5 })).rejects.toThrow(
    "Offset 5 is beyond end of file (4 lines total)",
  );
});

it("a trailing newline ends the last line without introducing an extra readable line", async () => {
  const read = createReadToolDefinition(process.cwd(), {
    operations: { access: async () => {}, readFile: async () => Buffer.from("one\ntwo\n") },
  });
  expect((await read.execute("all", { path: "example.txt" })).content).toEqual([
    { type: "text", text: "one\ntwo\n" },
  ]);
  expect((await read.execute("part", { path: "example.txt", limit: 1 })).content).toEqual([
    { type: "text", text: "one\n\n[1 more lines in file. Use offset=2 to continue.]" },
  ]);
  expect((await read.execute("last", { path: "example.txt", offset: 2, limit: 1 })).content).toEqual([
    { type: "text", text: "two\n" },
  ]);
  await expect(read.execute("past-end", { path: "example.txt", offset: 3 })).rejects.toThrow(
    "Offset 3 is beyond end of file (2 lines total)",
  );
});

it("empty files are readable and contain zero addressable lines", async () => {
  const read = createReadToolDefinition(process.cwd(), {
    operations: { access: async () => {}, readFile: async () => Buffer.alloc(0) },
  });
  expect((await read.execute("empty", { path: "example.txt" })).content).toEqual([
    { type: "text", text: "" },
  ]);
  await expect(read.execute("offset", { path: "example.txt", offset: 1 })).rejects.toThrow("0 lines total");
});
