import { createReadStream } from "node:fs";
import { open, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createReadToolDefinition, FileReadState } from "zpi-coding-agent";
import { temp } from "./helpers/workspace-fixture.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createReadStream: vi.fn(actual.createReadStream) };
});
afterEach(() => vi.clearAllMocks());

it("streams local ranges, counts the entire file and invalidates them when only the unread tail changes", async () => {
  const cwd = await temp();
  const path = join(cwd, "many-lines.txt");
  const count = 100_000;
  await writeFile(path, `${"line\n".repeat(count - 1)}tail\n`);
  const read = createReadToolDefinition(cwd);
  const args = { path, limit: 1 };
  const first = await read.execute("first", args);
  expect(first.content).toEqual([
    { type: "text", text: `line\n\n[${count - 1} more lines in file. Use offset=2 to continue.]` },
  ]);
  expect(createReadStream).toHaveBeenCalledWith(path, { encoding: "utf8", signal: undefined });
  expect((await read.execute("unchanged", args)).content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("File unchanged") }),
  ]);
  const before = await stat(path);
  const file = await open(path, "r+");
  await file.write("TAIL", before.size - 5, "utf8");
  await file.close();
  await utimes(path, before.atime, before.mtime);
  expect((await read.execute("changed-tail", args)).content).toEqual(first.content);
  expect((await read.execute("last", { path, offset: count, limit: 1 })).content).toEqual([
    { type: "text", text: "TAIL\n" },
  ]);
  await expect(read.execute("past-end", { path, offset: count + 1 })).rejects.toThrow(
    `Offset ${count + 1} is beyond end of file (${count} lines total)`,
  );
});

it("keeps decoded UTF-8 hashes compatible with successful writes and malformed input", async () => {
  const cwd = await temp();
  const path = join(cwd, "utf8.txt");
  const buffer = Buffer.concat([Buffer.from(`${"a".repeat(65535)}🙂\nlast\n`), Buffer.from([0xe2, 0x82])]);
  await writeFile(path, buffer);
  const state = new FileReadState();
  const read = createReadToolDefinition(cwd, { fileReadState: state });
  state.recordRead(path, buffer.toString("utf8"), 2, 1);
  expect((await read.execute("known", { path, offset: 2, limit: 1 })).content).toEqual([
    expect.objectContaining({ text: expect.stringContaining("File unchanged") }),
  ]);
  expect((await read.execute("replacement", { path, offset: 3 })).content).toEqual([
    { type: "text", text: "�" },
  ]);
});

it("leaves custom operations on their buffer contract without opening a local text stream", async () => {
  const path = "/remote-only/nonexistent.txt";
  const readFile = vi.fn(async () => Buffer.from("one\ntwo\n"));
  const read = createReadToolDefinition(process.cwd(), { operations: { access: async () => {}, readFile } });
  expect((await read.execute("remote", { path, offset: 2 })).content).toEqual([
    { type: "text", text: "two\n" },
  ]);
  expect(readFile).toHaveBeenCalledWith(path);
  expect(createReadStream).not.toHaveBeenCalled();
});

it("destroys an in-flight local stream on abort and does not cache the unfinished read", async () => {
  const cwd = await temp();
  const path = join(cwd, "large.txt");
  const file = await open(path, "w");
  await file.truncate(128 * 1024 * 1024);
  await file.close();
  const controller = new AbortController();
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  let stream: ReturnType<typeof createReadStream> | undefined;
  let closed: Promise<void> | undefined;
  vi.mocked(createReadStream).mockImplementationOnce((...args) => {
    stream = actual.createReadStream(...args);
    closed = new Promise<void>((resolve) => stream?.once("close", resolve));
    stream.once("data", () => controller.abort());
    return stream;
  });
  const read = createReadToolDefinition(cwd);
  await expect(read.execute("abort", { path, limit: 1 }, controller.signal)).rejects.toThrow("aborted");
  await closed;
  expect(stream?.destroyed).toBe(true);
  expect(stream?.closed).toBe(true);
  expect(stream?.bytesRead).toBeLessThan(128 * 1024 * 1024);
  expect(createReadStream).toHaveBeenCalledWith(path, { encoding: "utf8", signal: controller.signal });
  await writeFile(path, "done\n");
  expect((await read.execute("retry", { path, limit: 1 })).content).toEqual([
    { type: "text", text: "done\n" },
  ]);
});
