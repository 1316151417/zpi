import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";
import { expect, it, vi } from "vitest";
import { cleanupOutputFiles, OutputAccumulator } from "../src/core/tools/pi/output-accumulator.ts";

it("a temp-file error before finalization is caught and reported without losing the visible tail", async () => {
  const output = new OutputAccumulator({ maxBytes: 2, tempFilePrefix: `${randomUUID()}/missing` });
  output.append(Buffer.from("visible output"));
  // Let the failed open emit its error before closeTempFile attaches any completion listener.
  await new Promise((resolve) => setTimeout(resolve, 25));
  output.finish();
  await expect(output.closeTempFile()).rejects.toThrow("ENOENT");
  expect(output.snapshot().content).toBe("ut");
});

it("truncated output remains readable after the stream closes", async () => {
  const output = new OutputAccumulator({ maxBytes: 3 });
  output.append(Buffer.from("one\ntwo\n"));
  output.finish();
  const path = output.snapshot().fullOutputPath;
  if (!path) throw new Error("missing output path");
  try {
    await output.closeTempFile();
    expect(await readFile(path, "utf8")).toBe("one\ntwo\n");
    expect(await output.readFullOutput(100)).toEqual({ content: "one\ntwo\n", truncated: false });
  } finally {
    await rm(path, { force: true });
  }
});

it("cleanup removes only expired generated logs and preserves recent or unrelated files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-output-cleanup-"));
  try {
    const old = "zpi-bash-0123456789abcdef.log";
    const recent = "zpi-bash-fedcba9876543210.log";
    const unrelated = "zpi-bash-user.log";
    for (const name of [old, recent, unrelated]) await writeFile(join(dir, name), "output");
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const name of [old, unrelated]) await utimes(join(dir, name), expired, expired);
    await cleanupOutputFiles("zpi-bash", dir);
    expect((await readdir(dir)).sort()).toEqual([recent, unrelated].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, createWriteStream: vi.fn(actual.createWriteStream) };
});

it("bounds a slow spool to one producer chunk when the producer awaits drain", async () => {
  let persistedBytes = 0;
  const stream = new Writable({
    highWaterMark: 64 * 1024,
    write(chunk, _encoding, callback) {
      persistedBytes += chunk.length;
      setTimeout(callback, 1);
    },
  });
  vi.mocked(fs.createWriteStream).mockReturnValueOnce(stream as fs.WriteStream);
  const output = new OutputAccumulator();
  let peakPendingBytes = 0;
  for (let index = 0; index < 64; index++) {
    const pending = output.append(Buffer.alloc(1024 * 1024, 120));
    peakPendingBytes = Math.max(peakPendingBytes, stream.writableLength);
    expect(pending).toBeInstanceOf(Promise);
    await pending;
    expect(stream.writableLength).toBe(0);
  }
  output.finish();
  await output.closeTempFile();
  expect(peakPendingBytes).toBe(1024 * 1024);
  expect(persistedBytes).toBe(64 * 1024 * 1024);
  expect(output.snapshot()).toMatchObject({
    content: "x".repeat(50 * 1024),
    truncation: { truncated: true, totalBytes: persistedBytes },
  });
  expect(stream.listenerCount("drain")).toBe(0);
});

it("rejects a pending drain on disk failure and keeps the visible output tail", async () => {
  const failure = new Error("disk full");
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setImmediate(() => callback(failure));
    },
  });
  vi.mocked(fs.createWriteStream).mockReturnValueOnce(stream as fs.WriteStream);
  const output = new OutputAccumulator({ maxBytes: 4 });
  await expect(output.append(Buffer.from("visible output tail"))).rejects.toThrow("disk full");
  expect(() => output.append(Buffer.from("more"))).toThrow("disk full");
  output.finish();
  await expect(output.closeTempFile()).rejects.toThrow("disk full");
  expect(output.snapshot().content).toBe("tail");
  expect(stream.listenerCount("drain")).toBe(0);
});

it("settles a drain when finalization ends the stream before it emits drain", async () => {
  const stream = new Writable({
    highWaterMark: 1,
    write(_chunk, _encoding, callback) {
      setImmediate(callback);
    },
  });
  vi.mocked(fs.createWriteStream).mockReturnValueOnce(stream as fs.WriteStream);
  const output = new OutputAccumulator({ maxBytes: 1 });
  const pending = output.append(Buffer.from("output"));
  output.finish();
  await output.closeTempFile();
  await pending;
  expect(stream.listenerCount("drain")).toBe(0);
});
