import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import {
  type SessionEntry,
  SessionManager,
  type TranscriptSnapshot,
  type TranscriptState,
  type TranscriptStore,
} from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { buildSessionContext } from "../src/core/session-manager.ts";

function fixture() {
  const source = SessionManager.inMemory("/tmp");
  source.appendMessage({ role: "system", content: "instructions", timestamp: 1 });
  for (let i = 0; i < 100; i++) source.appendMessage({ role: "user", content: `old ${i}`, timestamp: i });
  const kept = source.appendMessage({ role: "user", content: "retained", timestamp: 0 });
  source.appendCompaction("summary", kept);
  source.appendMessage({ role: "user", content: "recent", timestamp: 0 });
  return source.getEntries();
}
function indexed(entries: SessionEntry[]) {
  let bodyReads = 0;
  let minimumRead = Infinity;
  const state = (view: TranscriptSnapshot): TranscriptState => {
    const prefix = entries.slice(0, view.endSeq);
    const context = buildSessionContext(prefix);
    return {
      ...context,
      hasThinkingEntry: false,
      lastMessageSeq: prefix.findLastIndex((e) => e.type === "message") + 1,
      lastCompactionSeq: prefix.findLastIndex((e) => e.type === "compaction") + 1,
    };
  };
  const store: TranscriptStore = {
    getHeader: () => ({
      type: "session",
      version: 2,
      format: "zpi",
      id: "indexed",
      cwd: "/tmp",
      timestamp: new Date().toISOString(),
    }),
    getFile: () => undefined,
    snapshot: () => ({ generation: "g1", endSeq: entries.length }),
    getStateAt: state,
    getTail: (view) =>
      view.endSeq ? { seq: view.endSeq, entry: structuredClone(entries[view.endSeq - 1]) } : undefined,
    readEntryById(id, view) {
      const seq = entries.findIndex((e, i) => i < view.endSeq && e.id === id) + 1;
      if (!seq) return undefined;
      bodyReads++;
      return { seq, entry: structuredClone(entries[seq - 1]) };
    },
    *readRange(start, end, view, types) {
      if (end > view.endSeq) throw new Error("Invalid watermark");
      minimumRead = Math.min(minimumRead, start);
      for (let seq = start; seq <= end; seq++) {
        if (types && !types.includes(entries[seq - 1].type)) continue;
        bodyReads++;
        yield { seq, entry: structuredClone(entries[seq - 1]) };
      }
    },
    getContextPlan(view) {
      const seq = entries.findLastIndex((e, i) => i < view.endSeq && e.type === "compaction") + 1;
      const entry = entries[seq - 1];
      return {
        snapshot: view,
        compaction: seq ? { seq, entry: structuredClone(entry) } : undefined,
        firstKeptSeq:
          entry?.type === "compaction" ? entries.findIndex((e) => e.id === entry.firstKeptEntryId) + 1 : 1,
      };
    },
    readUnresolvedToolJournals: () => [],
    append: (entry) => {
      entries.push(structuredClone(entry));
    },
    replace: (_header, replacement) => {
      entries.splice(0, entries.length, ...replacement);
    },
  };
  return { store, reads: () => bodyReads, minimum: () => minimumRead };
}
it("opens metadata-only and reads only retained context, preserving summary and timestamps", async () => {
  const entries = fixture();
  const expected = buildSessionContext(entries);
  const index = indexed(entries);
  const manager = await SessionManager.openAsync(index.store);
  expect(index.reads()).toBe(0);
  expect(() => manager.getEntries()).toThrow("iterateEntries");
  expect(await manager.materializeContext()).toEqual(expected);
  expect(index.minimum()).toBe(102);
  expect(index.reads()).toBe(3);
  manager.buildSessionContext();
  expect(index.reads()).toBe(3);
});
it("restores historical cutoffs before and after compaction without truncation", async () => {
  const entries = fixture();
  const manager = SessionManager.fromStore(indexed(entries).store);
  for (const endSeq of [1, 35, 102, 103, 104]) {
    expect(await manager.materializeContext({ generation: "g1", endSeq })).toEqual(
      buildSessionContext(entries.slice(0, endSeq)),
    );
  }
});
it("uses entry sequence provenance even when every read returns fresh objects and clocks tie", () => {
  const manager = SessionManager.fromStore(indexed(fixture()).store);
  const messages = manager.buildSessionContext().messages;
  expect(manager.precedesCompaction(messages[2])).toBe(true);
  expect(manager.precedesCompaction(messages[3])).toBe(false);
});
it("rejects missing, future and tool-result boundaries instead of silently dropping history", () => {
  for (const kind of ["missing", "future", "tool-result", "missing-system"]) {
    const entries = fixture();
    const compaction = entries[102];
    if (compaction.type !== "compaction") throw new Error("fixture");
    if (kind === "missing") compaction.firstKeptEntryId = "absent";
    if (kind === "future") compaction.firstKeptEntryId = entries[103].id;
    if (kind === "missing-system") delete compaction.systemMessage;
    if (kind === "tool-result")
      entries[101] = {
        ...entries[101],
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "orphan",
          toolName: "read",
          content: [],
          isError: false,
          timestamp: 1,
        },
      };
    expect(() => SessionManager.fromStore(indexed(entries).store).buildSessionContext()).toThrow();
  }
});
it("current choices update the state owner without adding transcript facts", () => {
  const entries = fixture();
  const before = entries.length;
  const calls: unknown[] = [];
  const manager = SessionManager.fromStore(indexed(entries).store, {
    get: () => ({
      model: { provider: "current", modelId: "new" },
      thinkingLevel: "off",
      lastThinkingLevel: "high",
      name: "current title",
    }),
    setModel: (...args) => {
      calls.push(args);
    },
    setThinkingLevel: (...args) => {
      calls.push(args);
    },
    setName: (...args) => {
      calls.push(args);
    },
  });
  manager.appendModelChange("provider", "model");
  manager.appendThinkingLevelChange("high");
  manager.appendSessionInfo("new name");
  expect(entries).toHaveLength(before);
  expect(calls).toEqual([["provider", "model"], ["high"], ["new name"]]);
  expect(manager.getCurrentState().model?.provider).toBe("current");
  expect(manager.getStateAt().model).toBeNull();
});

it("does not read completed journal payloads when materializing context", () => {
  const entries = fixture();
  entries.push({
    id: "large-journal",
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    type: "custom",
    customType: "zpi.streaming_tools",
    data: { id: "completed", committed: true, large: "x".repeat(100_000) },
  });
  const index = indexed(entries);
  const manager = SessionManager.fromStore(index.store);
  expect(manager.buildSessionContext()).toEqual(buildSessionContext(entries));
  expect(index.reads()).toBe(3);
});
it("retains all uncompressed multimodal content without preview substitution", () => {
  const manager = SessionManager.inMemory("/tmp");
  for (let i = 0; i < 100; i++)
    manager.appendMessage({
      role: "user",
      content: [
        { type: "text", text: `${i}` },
        { type: "image", data: "YWJj", mimeType: "image/png" },
      ],
      timestamp: i,
    });
  const index = indexed(manager.getEntries());
  const restored = SessionManager.fromStore(index.store);
  expect(index.reads()).toBe(0);
  expect(restored.buildSessionContext()).toEqual(manager.buildSessionContext());
  expect(index.reads()).toBe(100);
});

it("rewrites indexed transcripts lazily with stable remapped compaction boundaries", () => {
  const entries = fixture();
  const index = indexed([]);
  let produced = 0;
  let written: SessionEntry[] = [];
  index.store.replace = (_header, values) => {
    expect(Array.isArray(values)).toBe(false);
    const iterator = values[Symbol.iterator]();
    const first = iterator.next();
    expect(produced).toBe(1);
    if (!first.done) written.push(first.value);
    for (let next = iterator.next(); !next.done; next = iterator.next()) written.push(next.value);
  };
  function* source() {
    for (const entry of entries) {
      produced++;
      yield entry;
    }
  }
  const manager = SessionManager.fromStore(index.store);
  manager.replaceEntries(source());
  expect(produced).toBe(entries.length);
  expect(written.map((e) => e.id)).not.toContain(entries[0].id);
  expect(buildSessionContext(written)).toEqual(buildSessionContext(entries));
  expect(written.every((entry, i) => entry.parentId === (written[i - 1]?.id ?? null))).toBe(true);
  const firstGenerationId = written[0].id;
  written = [];
  produced = 0;
  manager.replaceEntries(source());
  expect(written[0].id).not.toBe(firstGenerationId);
});
it("reads the active file location from its store after generation replacement", () => {
  const index = indexed([]);
  let file = "/tmp/generation-a.jsonl";
  index.store.getFile = () => file;
  const manager = SessionManager.fromStore(index.store);
  expect(manager.getSessionFile()).toBe(file);
  file = "/tmp/generation-b.jsonl";
  expect(manager.getSessionFile()).toBe(file);
});

it("matches full-history projection at every cutoff across repeated compactions and system changes", () => {
  for (let seed = 1; seed <= 4; seed++) {
    const source = SessionManager.inMemory("/tmp");
    const boundaries: string[] = [];
    for (let i = 0; i < 35; i++) {
      if (i % 7 === 0)
        source.appendMessage({
          role: "system",
          content: `system ${i}`,
          sections: { stable: "keep", changed: `${i}` },
          timestamp: 100 - i,
        });
      boundaries.push(
        source.appendMessage({
          role: "user",
          content: [
            { type: "text", text: `seed ${seed}, message ${i}` },
            { type: "image", data: "YWJj", mimeType: "image/png" },
          ],
          timestamp: 100 - i,
        }),
      );
      if (i > 0 && i % 8 === 0) source.appendCompaction(`summary ${i}`, boundaries[Math.max(0, i - seed)]);
    }
    const entries = source.getEntries();
    const manager = SessionManager.fromStore(indexed(entries).store);
    for (let endSeq = 0; endSeq <= entries.length; endSeq++) {
      expect(manager.buildSessionContext({ generation: "g1", endSeq })).toEqual(
        buildSessionContext(entries.slice(0, endSeq)),
      );
    }
  }
});

it("rejects a tool result after a non-tool boundary when its declaration was summarized", () => {
  const entries = fixture();
  entries.push({
    id: "orphan-after-boundary",
    parentId: entries.at(-1)?.id ?? null,
    timestamp: new Date().toISOString(),
    type: "message",
    message: {
      role: "toolResult",
      toolCallId: "summarized-call",
      toolName: "read",
      content: [],
      isError: false,
      timestamp: 0,
    },
  });
  expect(() => SessionManager.fromStore(indexed(entries).store).buildSessionContext()).toThrow(
    "missing retained declaration",
  );
});

it("preserves signed multimodal content and reused tool IDs across retained turns", () => {
  const source = SessionManager.inMemory("/tmp");
  source.appendMessage({ role: "system", content: "instructions", timestamp: 0 });
  source.appendMessage({ role: "user", content: "summarized", timestamp: 0 });
  const kept = source.appendMessage({
    role: "user",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: 0,
  });
  for (let turn = 0; turn < 2; turn++) {
    const assistant = emptyAssistant(fakeModel(""));
    assistant.responseId = `response-${turn}`;
    assistant.thinkingLevel = "high";
    assistant.content = [
      { type: "text", text: "text", textSignature: "signed-text" },
      { type: "thinking", thinking: "", thinkingSignature: "signed-thought", redacted: true },
      {
        type: "toolCall",
        id: "reused",
        name: "read",
        namespace: "provider",
        thoughtSignature: "signed-call",
        arguments: { path: "file" },
      },
    ];
    source.appendMessage(assistant);
    source.appendMessage({
      role: "toolResult",
      toolCallId: "reused",
      toolName: "read",
      content: [{ type: "text", text: "result" }],
      isError: false,
      timestamp: 0,
    });
    if (turn === 0) source.appendCompaction("summary", kept);
  }
  const entries = source.getEntries();
  const manager = SessionManager.fromStore(indexed(entries).store);
  const expected = buildSessionContext(entries);
  expect(manager.buildSessionContext()).toEqual(expected);
  expect(JSON.stringify(manager.buildSessionContext().messages)).toBe(JSON.stringify(expected.messages));
});
