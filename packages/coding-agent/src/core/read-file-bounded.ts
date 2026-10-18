import { open } from "node:fs/promises";

/** Read at most maxBytes + 1, including when a file grows after it was inspected. */
export async function readFileBounded(path: string, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes >= Number.MAX_SAFE_INTEGER)
    throw new Error("Invalid file byte limit");
  const file = await open(path, "r");
  try {
    // Reject known oversized inputs before allocating or reading their contents. The loop also guards growth.
    if ((await file.stat()).size > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte size limit`);
    const chunks: Buffer[] = [];
    let length = 0;
    while (length <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - length));
      const { bytesRead } = await file.read(chunk, 0, chunk.length, null);
      if (!bytesRead) return Buffer.concat(chunks, length);
      length += bytesRead;
      if (length > maxBytes) throw new Error(`File exceeds the ${maxBytes} byte size limit`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    throw new Error("File byte limit exceeded");
  } finally {
    await file.close();
  }
}
