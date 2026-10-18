import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { Check } from "typebox/value";
import { expect, it, vi } from "vitest";
import { createReadToolDefinition, imageLimits } from "zpi-coding-agent";

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

it("local image reads reject oversized sources before decoding and retain ordinary image behavior", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-read-image-"));
  try {
    const original = await sharp({ create: { width: 3, height: 2, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const path = join(dir, "source.png");
    const read = createReadToolDefinition(dir);
    await writeFile(path, original);
    const result = await read.execute("normal", { path });
    const image = result.content.find((part) => part.type === "image");
    expect(image?.type).toBe("image");
    if (image?.type === "image")
      expect(Buffer.from(image.data, "base64").length).toBeLessThan(5 * 1024 * 1024);
    const aboveAttachmentLimit = Buffer.alloc(11 * 1024 * 1024);
    original.copy(aboveAttachmentLimit);
    await writeFile(path, aboveAttachmentLimit);
    const padded = await read.execute("above-attachment-limit", { path });
    expect(padded.content).toEqual([{ type: "text", text: expect.stringContaining("processing_failed") }]);
    const oversized = Buffer.alloc(imageLimits.readSourceBytes + 1);
    original.copy(oversized);
    await writeFile(path, oversized);
    await expect(read.execute("oversized", { path })).rejects.toThrow("byte size limit");
    await writeFile(path, original.subarray(0, 40));
    expect((await read.execute("truncated", { path })).content).toEqual([
      expect.objectContaining({ type: "text", text: expect.stringContaining("Image omitted") }),
    ]);
    await expect(read.execute("missing", { path: join(dir, "missing.png") })).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("image reads pass a source limit to custom readers and guard readers that ignore it", async () => {
  const readFile = vi.fn(async () => Buffer.alloc(imageLimits.readSourceBytes + 1));
  const read = createReadToolDefinition(process.cwd(), {
    operations: { access: async () => {}, detectImageMimeType: async () => "image/png", readFile },
  });
  await expect(read.execute("large", { path: "custom.png" })).rejects.toThrow("byte size limit");
  expect(readFile).toHaveBeenCalledWith(expect.stringContaining("custom.png"), imageLimits.readSourceBytes);
});
