import { closeSync, openSync, readSync } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { maxSessionEntryBytes, type SessionEntry } from "zpi-coding-agent";

/** Relocate artifacts with bounded records; spool IO yields to the main event loop. */
export async function stageTranscript(
  source: Iterable<SessionEntry>,
  transform: (entry: SessionEntry) => Promise<SessionEntry | undefined>,
): Promise<{ entries: () => Iterable<SessionEntry>; close: () => Promise<void> }> {
  const directory = await mkdtemp(join(tmpdir(), "zpi-transcript-copy-"));
  const path = join(directory, "entries.jsonl");
  const output = await open(path, "wx", 0o600);
  try {
    for (const entry of source) {
      const next = await transform(entry);
      if (!next) continue;
      const bytes = Buffer.from(`${JSON.stringify(next)}\n`);
      if (bytes.length - 1 > maxSessionEntryBytes) throw new Error("storage: 复制记录超过大小限制");
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesWritten } = await output.write(bytes, offset);
        if (!bytesWritten) throw new Error("storage: Transcript spool write made no progress");
        offset += bytesWritten;
      }
    }
    await output.sync();
  } catch (error) {
    await output.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  await output.close();
  return {
    entries: () => readTranscriptEntries(path),
    close: () => rm(directory, { recursive: true, force: true }),
  };
}

/** Shared bounded reader for unpublished entry spools; the worker owns final validation. */
export function* readTranscriptEntries(path: string): Iterable<SessionEntry> {
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
        const record = pieces.length ? Buffer.concat([...pieces, tail], pendingBytes + tail.length) : tail;
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
}
