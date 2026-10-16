/** PDF.js may combine multiple chunks into one request; keep each IPC allocation bounded. */
export async function readPdfRange(
  offset: number,
  length: number,
  read: (offset: number, length: number) => Promise<Uint8Array>,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  const result = new Uint8Array(length);
  for (let cursor = 0; cursor < length; ) {
    const size = Math.min(1024 * 1024, length - cursor);
    signal?.throwIfAborted();
    const chunk = await read(offset + cursor, size);
    signal?.throwIfAborted();
    if (chunk.length !== size) throw new Error("PDF 文件已变化，请刷新预览。");
    result.set(chunk, cursor);
    cursor += size;
  }
  return result;
}
