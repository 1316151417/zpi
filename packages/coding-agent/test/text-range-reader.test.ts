import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { expect, it } from "vitest";
import { readTextRange } from "../src/core/tools/pi/text-range-reader.ts";
import { DEFAULT_MAX_BYTES, truncateHead } from "../src/core/tools/pi/truncate.ts";

function* decodeChunks(buffer: Buffer, size: number) {
  const decoder = new StringDecoder("utf8");
  for (let start = 0; start < buffer.length; start += size) {
    yield decoder.write(buffer.subarray(start, start + size));
  }
  yield decoder.end();
}

// The original full-buffer selection is the compatibility oracle.
function expectedRange(buffer: Buffer, offset?: number, limit?: number) {
  const text = buffer.toString("utf8");
  const lines = text ? text.split("\n") : [];
  if (text.endsWith("\n")) lines.pop();
  const start = (offset ?? 1) - 1;
  let selected = lines.slice(start, limit === undefined ? undefined : start + limit).join("\n");
  if (text.endsWith("\n") && (limit === undefined || start + limit >= lines.length)) selected += "\n";
  return {
    hash: createHash("sha256").update(text).digest("hex"),
    totalFileLines: lines.length,
    firstLineBytes: Buffer.byteLength(lines[start] ?? "", "utf8"),
    truncation: truncateHead(selected),
  };
}

it("matches full-buffer selection for empty lines, CRLF, UTF-8 boundaries and missing final newlines", async () => {
  const inputs = ["", "\n", "\n\n", "one\ntwo\n", "one\n\nlast", "a\r\nb\r\n", "\uFEFFé中🙂\n\n尾"];
  for (const input of inputs) {
    const buffer = Buffer.from(input);
    for (const size of [1, 2, 3, 7, 65536]) {
      for (const offset of [undefined, 1, 2, 3]) {
        for (const limit of [undefined, 1, 2, Number.MAX_SAFE_INTEGER]) {
          // The tool rejects out-of-range offsets before using the selected content.
          if (offset !== undefined && offset > expectedRange(buffer).totalFileLines) continue;
          const result = await readTextRange(decodeChunks(buffer, size), offset, limit);
          expect(result).toEqual(expectedRange(buffer, offset, limit));
        }
      }
    }
  }
});

it("preserves truncation metadata at byte and line limits, including selected trailing blank lines", async () => {
  const inputs = [
    "x".repeat(DEFAULT_MAX_BYTES),
    `${"x".repeat(DEFAULT_MAX_BYTES)}\n`,
    `${"x".repeat(DEFAULT_MAX_BYTES)}\n\nlast`,
    `${"x".repeat(DEFAULT_MAX_BYTES - 1)}\n\nlast`,
    `${"x".repeat(DEFAULT_MAX_BYTES - 1)}🙂\nlast`,
    `${"中".repeat(DEFAULT_MAX_BYTES)}\nlast`,
    `${"\n".repeat(2000)}last`,
    `${"\n".repeat(2001)}last`,
    `${"x\n".repeat(2000)}\nlast`,
  ];
  for (const input of inputs) {
    const buffer = Buffer.from(input);
    for (const size of [4093, 65536]) {
      for (const [offset, limit] of [
        [undefined, undefined],
        [1, 1],
        [1, 2],
        [1, 2001],
        [2, undefined],
      ]) {
        if (offset !== undefined && offset > expectedRange(buffer).totalFileLines) continue;
        expect(await readTextRange(decodeChunks(buffer, size), offset, limit)).toEqual(
          expectedRange(buffer, offset, limit),
        );
      }
    }
  }
});

it("hashes and counts malformed UTF-8 exactly like Buffer.toString across chunk boundaries", async () => {
  const buffer = Buffer.from([0x61, 0xe4, 0xb8, 0x0a, 0xff, 0xf0, 0x9f, 0x99, 0x82, 0x0a, 0xe2, 0x82]);
  for (const size of [1, 2, 3, 7]) {
    expect(await readTextRange(decodeChunks(buffer, size))).toEqual(expectedRange(buffer));
  }
});

it("consumes giant lines without a growing line carry and can select content after them", async () => {
  const chunk = "x".repeat(64 * 1024);
  async function* giantLine() {
    for (let i = 0; i < 1024; i++) yield chunk;
    yield "\nlast\n";
  }
  const first = await readTextRange(giantLine(), 1, 1);
  expect(first.firstLineBytes).toBe(64 * 1024 * 1024);
  expect(first.totalFileLines).toBe(2);
  expect(first.truncation).toMatchObject({
    content: "",
    totalBytes: 64 * 1024 * 1024,
    totalLines: 1,
    firstLineExceedsLimit: true,
  });
  const last = await readTextRange(giantLine(), 2, 1);
  expect(last.truncation).toEqual(truncateHead("last\n"));
  expect(last.hash).toBe(first.hash);
});
