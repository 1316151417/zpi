import { closeSync, fsyncSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxSessionEntryBytes, type SessionEntry } from "zpi-coding-agent";

/** Async artifact relocation spools one record at a time for the synchronous durable writer. */
export async function stageTranscript(
  source: Iterable<SessionEntry>,
  transform: (entry: SessionEntry) => Promise<SessionEntry | undefined>,
): Promise<{ entries: () => Iterable<SessionEntry>; close: () => void }> {
  const directory = mkdtempSync(join(tmpdir(), "zpi-transcript-copy-"));
  const path = join(directory, "entries.jsonl");
  const fd = openSync(path, "wx", 0o600);
  try {
    for (const entry of source) {
      const next = await transform(entry);
      if (!next) continue;
      const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
      let written = 0;
      while (written < bytes.length) written += writeSync(fd, bytes, written);
    }
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
  closeSync(fd);
  return {
    *entries() {
      const input = openSync(path, "r");
      const chunk = Buffer.alloc(64 * 1024);
      const pieces: Buffer[] = [];
      let pendingBytes = 0;
      try {
        for (;;) {
          const size = readSync(input, chunk);
          if (!size) break;
          let start = 0;
          for (;;) {
            const end = chunk.indexOf(10, start);
            if (end < 0 || end >= size) break;
            const tail = chunk.subarray(start, end);
            const record = pieces.length
              ? Buffer.concat([...pieces, tail], pendingBytes + tail.length)
              : tail;
            pieces.length = 0;
            pendingBytes = 0;
            yield JSON.parse(record.toString("utf8")) as SessionEntry;
            start = end + 1;
          }
          if (start < size) {
            // readSync reuses chunk, so retained pieces must own their bytes.
            pieces.push(Buffer.from(chunk.subarray(start, size)));
            pendingBytes += size - start;
          }
          if (pendingBytes > maxSessionEntryBytes) throw new Error("storage: 复制记录超过大小限制");
        }
        if (pendingBytes) throw new Error("storage: 复制记录不完整");
      } finally {
        closeSync(input);
      }
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
