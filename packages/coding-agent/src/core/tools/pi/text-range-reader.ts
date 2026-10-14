import { createHash } from "node:crypto";
import { DEFAULT_MAX_BYTES, truncateHead } from "./truncate.ts";

/**
 * Count and hash the entire decoded file, but retain only a bounded prefix of the
 * requested range. Never buffer a whole line: a single line can be arbitrarily large.
 */
export async function readTextRange(
  chunks: AsyncIterable<string> | Iterable<string>,
  offset?: number,
  limit?: number,
) {
  const hash = createHash("sha256");
  const startLine = (offset ?? 1) - 1;
  // Two bytes past the output limit ensure truncateHead sees an overflowing line,
  // even if the first extra byte is a newline that its line counter trims.
  const prefixLimit = DEFAULT_MAX_BYTES + 2;
  let prefix = "";
  let prefixBytes = 0;
  let totalFileLines = 0;
  let selectedLines = 0;
  let selectedBytes = 0;
  let firstLineBytes = 0;
  let lineBytes = 0;
  let lastLineBytes = 0;
  let lineStarted = false;
  let endsWithNewline = false;

  const append = (text: string) => {
    selectedBytes += Buffer.byteLength(text, "utf8");
    if (prefixBytes >= prefixLimit) return;
    // UTF-16 length bounds the retained UTF-8 bytes by a constant factor. Keep a
    // complete surrogate pair at the boundary, preserving the exact text prefix.
    let end = Math.min(text.length, prefixLimit - prefixBytes);
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff && end < text.length) end++;
    const part = text.slice(0, end);
    prefix += part;
    prefixBytes += Buffer.byteLength(part, "utf8");
  };
  const consume = (chunk: string, start: number, end: number, newline: boolean) => {
    if (totalFileLines >= startLine && (limit === undefined || totalFileLines - startLine < limit)) {
      if (!lineStarted && selectedLines > 0) append("\n");
      const part = chunk.slice(start, end);
      append(part);
      lineBytes += Buffer.byteLength(part, "utf8");
      if (newline) {
        if (selectedLines === 0) firstLineBytes = lineBytes;
        lastLineBytes = lineBytes;
        selectedLines++;
        lineBytes = 0;
      }
    }
    lineStarted = !newline;
    if (newline) totalFileLines++;
  };

  for await (const chunk of chunks) {
    if (chunk.length === 0) continue;
    // Hash decoded text, matching FileReadState even for malformed UTF-8 input.
    hash.update(chunk);
    let start = 0;
    let end = chunk.indexOf("\n");
    while (end !== -1) {
      consume(chunk, start, end, true);
      start = end + 1;
      end = chunk.indexOf("\n", start);
    }
    if (start < chunk.length) consume(chunk, start, chunk.length, false);
    endsWithNewline = chunk.endsWith("\n");
  }
  if (lineStarted) consume("", 0, 0, true);

  const finalNewline =
    selectedLines > 0 && endsWithNewline && (limit === undefined || limit >= totalFileLines - startLine);
  if (finalNewline) append("\n");
  // Joining a range ending in an empty line itself produces a trailing newline.
  const totalLines = selectedBytes === 0 ? 0 : selectedLines - Number(!finalNewline && lastLineBytes === 0);
  const truncation = { ...truncateHead(prefix), totalLines, totalBytes: selectedBytes };
  return { hash: hash.digest("hex"), totalFileLines, firstLineBytes, truncation };
}
