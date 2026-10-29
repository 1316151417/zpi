import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Inspect the opened handle without waiting for a FIFO writer, including through symlinks. */
export async function readRegularFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    if (!(await file.stat()).isFile()) throw new Error("File mutation requires a regular file");
    return await file.readFile();
  } finally {
    await file.close();
  }
}
