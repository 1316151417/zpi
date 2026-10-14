import { expect, it, vi } from "vitest";

const { open } = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock("node:fs/promises", () => ({ open }));

import { readFileBounded } from "../src/core/read-file-bounded.ts";

it("reads no more than max + 1 bytes and closes the handle on oversized input", async () => {
  let consumed = 0;
  const close = vi.fn(async () => {});
  open.mockResolvedValue({
    read: vi.fn(async (_buffer: Buffer, _offset: number, length: number) => {
      consumed += length;
      return { bytesRead: length };
    }),
    close,
  });
  await expect(readFileBounded("growing-image", 100_000)).rejects.toThrow("byte size limit");
  expect(consumed).toBe(100_001);
  expect(close).toHaveBeenCalledOnce();
});

it("closes handles on read errors and handles short reads without truncating the source", async () => {
  const close = vi.fn(async () => {});
  const read = vi.fn().mockRejectedValueOnce(new Error("read failed"));
  open.mockResolvedValue({ read, close });
  await expect(readFileBounded("failed", 10)).rejects.toThrow("read failed");
  expect(close).toHaveBeenCalledOnce();
  let remaining = 7;
  read.mockImplementation(async (buffer: Buffer) => {
    const bytesRead = Math.min(remaining, 2);
    buffer.fill(123, 0, bytesRead);
    remaining -= bytesRead;
    return { bytesRead };
  });
  expect(await readFileBounded("short-reads", 7)).toEqual(Buffer.alloc(7, 123));
  expect(close).toHaveBeenCalledTimes(2);
});
