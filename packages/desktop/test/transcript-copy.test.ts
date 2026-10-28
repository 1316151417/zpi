import { closeSync, existsSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { maxSessionEntryBytes, type SessionEntry } from "zpi-coding-agent";
import { sessionReferenceTranscriptReverse } from "../src/main/session-references.ts";
import { stageTranscript } from "../src/main/transcript-copy.ts";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, closeSync: vi.fn(fs.closeSync) };
});

const spools = vi.hoisted(() => [] as string[]);
vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...fs,
    mkdtemp: vi.fn(async (prefix: string) => {
      const path = await fs.mkdtemp(prefix);
      spools.push(path);
      return path;
    }),
  };
});

function message(content: string): SessionEntry {
  return {
    id: "entry",
    parentId: null,
    timestamp: "2026-10-14T00:00:00Z",
    type: "message",
    message: { role: "user", content, timestamp: 0 },
  };
}

function spoolDirectory(): string {
  return spools.at(-1) as string;
}

test("spool reads preserve split UTF-8, multiple lines and large records across reused chunks", async () => {
  const prefix = JSON.stringify(message("")).indexOf('"content":"') + '"content":"'.length;
  // Place the first byte of a three-byte character at the last byte of a read buffer.
  const split = message(`${"x".repeat(64 * 1024 - prefix - 1)}中后续`);
  const large = message("中文".repeat(300_000));
  const entries = [split, message("small one"), message("small two"), large, message("last")];
  const staged = await stageTranscript(entries, async (entry) => entry);
  const directory = spoolDirectory();
  try {
    expect([...staged.entries()]).toEqual(entries);
    expect([...staged.entries()]).toEqual(entries);
  } finally {
    await staged.close();
  }
  expect(existsSync(directory)).toBe(false);
});

test.each([
  ["unterminated", "storage: 复制记录不完整"],
  ["oversize", "storage: 复制记录超过大小限制"],
  ["invalid", "Unexpected"],
])("spool closes its reader after %s records and remains removable", async (kind, error) => {
  const staged = await stageTranscript([message("original")], async (entry) => entry);
  const directory = spoolDirectory();
  const path = join(directory, "entries.jsonl");
  if (kind === "unterminated") truncateSync(path, statSync(path).size - 1);
  else if (kind === "oversize") writeFileSync(path, "x".repeat(maxSessionEntryBytes + 1));
  else writeFileSync(path, "invalid JSON\n");
  const closes = vi.mocked(closeSync).mock.calls.length;
  try {
    expect(() => [...staged.entries()]).toThrow(error);
    expect(vi.mocked(closeSync).mock.calls.length).toBe(closes + 1);
  } finally {
    await staged.close();
  }
  expect(existsSync(directory)).toBe(false);
});

test("spool closes an abandoned iterator and removes staging files after transform failure", async () => {
  const staged = await stageTranscript([message("one"), message("two")], async (entry) => entry);
  const directory = spoolDirectory();
  const closes = vi.mocked(closeSync).mock.calls.length;
  try {
    for (const _entry of staged.entries()) break;
    expect(vi.mocked(closeSync).mock.calls.length).toBe(closes + 1);
  } finally {
    await staged.close();
  }
  expect(existsSync(directory)).toBe(false);
  await expect(
    stageTranscript([message("one")], async () => {
      throw new Error("transform failed");
    }),
  ).rejects.toThrow("transform failed");
  expect(existsSync(spoolDirectory())).toBe(false);
});

test("artifact relocation spools incrementally and permits independent bounded rereads", async () => {
  let consumed = 0;
  const source = function* (): Iterable<SessionEntry> {
    for (let i = 0; i < 500; i++) {
      consumed++;
      yield {
        id: String(i),
        parentId: i ? String(i - 1) : null,
        timestamp: "2026-10-14T00:00:00Z",
        type: "message",
        message: { role: "user", content: `中文${i}`, timestamp: i },
      };
    }
  };
  let transformed = 0;
  const staged = await stageTranscript(source(), async (entry) => {
    transformed++;
    expect(consumed).toBe(transformed);
    return entry;
  });
  try {
    expect([...staged.entries()]).toHaveLength(500);
    expect([...staged.entries()][499]).toMatchObject({ message: { content: "中文499" } });
  } finally {
    await staged.close();
  }
});
test("reference export stops consuming history after its visible text budget", () => {
  let consumed = 0;
  const source = function* (): Iterable<SessionEntry> {
    for (let i = 0; i < 10000; i++) {
      consumed++;
      yield {
        id: String(i),
        parentId: null,
        timestamp: "2026-10-14T00:00:00Z",
        type: "custom",
        customType: "zpi.run",
        data: { phase: "start", text: "x".repeat(16000) },
      };
    }
  };
  const result = sessionReferenceTranscriptReverse("test", "task", source());
  expect(result).toContain("Earlier history omitted");
  expect(consumed).toBeLessThan(10);
});
