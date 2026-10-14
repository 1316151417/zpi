import { closeSync, fsyncSync, mkdtempSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionEntry } from "zpi-coding-agent";

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
      let pending = Buffer.alloc(0);
      try {
        for (;;) {
          const size = readSync(input, chunk);
          if (!size) break;
          pending = Buffer.concat([pending, chunk.subarray(0, size)]);
          let start = 0;
          for (;;) {
            const end = pending.indexOf(10, start);
            if (end < 0) break;
            yield JSON.parse(pending.subarray(start, end).toString("utf8")) as SessionEntry;
            start = end + 1;
          }
          pending = Buffer.from(pending.subarray(start));
          if (pending.length > 8 * 1024 * 1024) throw new Error("storage: 复制记录超过大小限制");
        }
        if (pending.length) throw new Error("storage: 复制记录不完整");
      } finally {
        closeSync(input);
      }
    },
    close: () => rmSync(directory, { recursive: true, force: true }),
  };
}
