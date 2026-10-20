import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, mkdtemp, open, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { readFilePreview, readPreviewRange } from "../src/main/file-preview.ts";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, open: vi.fn(actual.open) };
});

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "zpi-preview-special-")));
});
afterEach(async () => {
  vi.mocked(open).mockReset();
  await rm(root, { recursive: true, force: true });
});
const mkfifo = (path: string) => promisify(execFile)("mkfifo", [path]);
const readers = [
  ["preview", (path: string) => readFilePreview(root, path)],
  ["PDF range", (path: string) => readPreviewRange(root, path, 0, 1)],
] as const;

async function boundedRead(path: string, reading: Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      reading,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Preview blocked opening a special file")), 1000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    // Unblock a regressed blocking open as well, so a failed test cannot strand a libuv worker.
    if ((await lstat(path)).isFIFO()) {
      const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      const release = await actual.open(path, constants.O_RDWR | constants.O_NONBLOCK);
      await reading.catch(() => {});
      await release.close();
    }
  }
}

test.skipIf(process.platform === "win32").each(readers)(
  "%s rejects a FIFO without a writer",
  async (_, read) => {
    const path = join(root, "pipe.pdf");
    await mkfifo(path);
    await expect(boundedRead(path, read(path))).rejects.toThrow("普通文件");
  },
);

test.skipIf(process.platform === "win32").each(readers)(
  "%s rejects a regular file replaced by a FIFO before open and closes its descriptor",
  async (_, read) => {
    const path = join(root, "changed.pdf");
    await writeFile(path, "%PDF-preview");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await unlink(path);
      await mkfifo(path);
      opened = await actual.open(...args);
      return opened;
    });
    await expect(boundedRead(path, read(path))).rejects.toThrow("普通文件");
    expect(opened?.fd).toBe(-1);
  },
);

test.skipIf(process.platform === "win32").each(readers)(
  "%s refuses a symlink substituted after path resolution",
  async (_, read) => {
    const path = join(root, "changed.pdf");
    const other = join(root, "other.pdf");
    await writeFile(path, "%PDF-original");
    await writeFile(other, "%PDF-other");
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      await unlink(path);
      await symlink(other, path);
      return actual.open(...args);
    });
    await expect(read(path)).rejects.toMatchObject({ code: "ELOOP" });
  },
);
