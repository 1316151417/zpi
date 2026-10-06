import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
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
  const dir = await mkdtemp(join(tmpdir(), "ZPI-output-cleanup-"));
  try {
    const old = "ZPI-bash-0123456789abcdef.log";
    const recent = "ZPI-bash-fedcba9876543210.log";
    const unrelated = "ZPI-bash-user.log";
    for (const name of [old, recent, unrelated]) await writeFile(join(dir, name), "output");
    const expired = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    for (const name of [old, unrelated]) await utimes(join(dir, name), expired, expired);
    await cleanupOutputFiles("ZPI-bash", dir);
    expect((await readdir(dir)).sort()).toEqual([recent, unrelated].sort());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
