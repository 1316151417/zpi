import { expect, test } from "vitest";
import type { SessionEntry } from "zpi-coding-agent";
import { sessionReferenceTranscriptReverse } from "../src/main/session-references.ts";
import { stageTranscript } from "../src/main/transcript-copy.ts";

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
    staged.close();
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
