import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readFileBounded } from "zpi-coding-agent";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it("bounded reads preserve empty, short, multi-chunk and exactly-at-limit files", async () => {
  const dir = await mkdtemp(join(tmpdir(), "zpi-bounded-"));
  directories.push(dir);
  for (const length of [0, 1, 65_537, 131_072]) {
    const bytes = Buffer.alloc(length, 173);
    const path = join(dir, String(length));
    await writeFile(path, bytes);
    expect(await readFileBounded(path, length)).toEqual(bytes);
    expect(await readFileBounded(path, length + 10)).toEqual(bytes);
    if (length) await expect(readFileBounded(path, length - 1)).rejects.toThrow("byte size limit");
  }
  await expect(readFileBounded(join(dir, "missing"), 10)).rejects.toMatchObject({ code: "ENOENT" });
  await expect(readFileBounded(dir, 10)).rejects.toThrow();
  for (const limit of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER])
    await expect(readFileBounded(join(dir, "missing"), limit)).rejects.toThrow("Invalid file byte limit");
});
