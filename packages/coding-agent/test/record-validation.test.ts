import { expect, it } from "vitest";
import { isSessionEntry, isSessionHeader, validateMessage } from "../src/core/record-validation.ts";

const usage = {
  input: 10,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  totalTokens: 19,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const messages = [
  { role: "user", content: "hello", timestamp: 1 },
  { role: "user", content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }], timestamp: 1 },
  {
    role: "system",
    content: [{ type: "text", text: "rules" }],
    timestamp: 1,
    sections: { a: "rules", b: null },
    toolsAdded: [{ name: "write", description: "write", parameters: { type: "object", properties: {} } }],
    toolsRemoved: [{ name: "old" }],
  },
  {
    role: "assistant",
    content: [
      { type: "text", text: "hello" },
      { type: "thinking", thinking: "reason" },
      { type: "toolCall", id: "call", name: "write", arguments: { path: "file", content: "value" } },
    ],
    api: "openai-completions",
    provider: "custom",
    model: "test",
    timestamp: 1,
    usage,
    stopReason: "toolUse",
  },
  {
    role: "toolResult",
    toolCallId: "call",
    toolName: "write",
    content: [{ type: "text", text: "done" }],
    isError: false,
    timestamp: 1,
    details: { fileChange: { path: "file", beforeFile: "/tmp/example" } },
  },
];
const common = { id: "entry", parentId: null, timestamp: "2026-10-16T00:00:00.000Z" };
const entries = [
  ...messages.map((message) => ({ ...common, type: "message", message })),
  { ...common, type: "model_change", provider: "custom", modelId: "test" },
  { ...common, type: "thinking_level_change", thinkingLevel: "future-compatible" },
  { ...common, type: "session_info", name: "name" },
  { ...common, type: "custom", customType: "external.extension", data: { deeply: [null, { key: "value" }] } },
  // Legacy records intentionally allow an omitted complete system snapshot; v2 enforces it separately.
  { ...common, type: "compaction", summary: "legacy summary", firstKeptEntryId: "kept" },
  {
    ...common,
    type: "compaction",
    summary: "summary",
    firstKeptEntryId: "kept",
    usage,
    systemMessage: messages[2],
    details: { readFiles: ["a"], modifiedFiles: ["b"] },
    tokensBefore: 123,
  },
];
const invalidValues = [undefined, null, false, 0, NaN, Infinity, "", [], {}];

it("validates canonical session headers and rejects missing fields or unsafe identifiers", () => {
  const header = {
    type: "session",
    version: 1,
    format: "zpi",
    id: "valid-id_1",
    cwd: "/tmp",
    timestamp: "date",
  };
  expect(isSessionHeader(header)).toBe(true);
  expect(isSessionHeader({ ...header, futureExtension: true })).toBe(true);
  for (const value of invalidValues) expect(isSessionHeader(value)).toBe(false);
  for (const key of Object.keys(header)) {
    const missing = { ...header } as Record<string, unknown>;
    delete missing[key];
    expect(isSessionHeader(missing)).toBe(false);
    expect(isSessionHeader({ ...header, [key]: null })).toBe(false);
  }
  expect(isSessionHeader({ ...header, id: "../invalid" })).toBe(false);
  expect(isSessionHeader({ ...header, version: 2 })).toBe(false);
  expect(isSessionHeader({ ...header, format: "ZPI" })).toBe(false);
});

it("accepts every entry kind and legacy compactions while rejecting malformed identities and payloads", () => {
  for (const value of entries) {
    expect(isSessionEntry(value)).toBe(true);
    expect(isSessionEntry({ ...value, futureExtension: { retained: true } })).toBe(true);
    for (const key of ["id", "parentId", "timestamp", "type"]) {
      const missing = { ...value } as Record<string, unknown>;
      delete missing[key];
      expect(isSessionEntry(missing)).toBe(false);
    }
    expect(isSessionEntry({ ...value, id: 1 })).toBe(false);
    expect(isSessionEntry({ ...value, parentId: {} })).toBe(false);
    expect(isSessionEntry({ ...value, type: "unknown" })).toBe(false);
  }
  for (const value of invalidValues) expect(isSessionEntry(value)).toBe(false);
  for (const value of invalidValues)
    expect(isSessionEntry({ ...common, type: "message", message: value })).toBe(false);
  expect(isSessionEntry({ ...common, type: "thinking_level_change", thinkingLevel: "   " })).toBe(false);
  expect(isSessionEntry({ ...common, type: "thinking_level_change", thinkingLevel: "x".repeat(129) })).toBe(
    false,
  );
  expect(isSessionEntry({ ...common, type: "compaction", summary: "summary" })).toBe(false);
  expect(
    isSessionEntry({
      ...common,
      type: "compaction",
      summary: "summary",
      firstKeptEntryId: "kept",
      systemMessage: {},
    }),
  ).toBe(false);
  expect(
    isSessionEntry({
      ...common,
      type: "compaction",
      summary: "summary",
      firstKeptEntryId: "kept",
      usage: { ...usage, cost: null },
    }),
  ).toBe(false);
});

it("preserves message validation for nested usage, tool calls, content, and system snapshots", () => {
  for (const message of messages) {
    expect(() => validateMessage(message)).not.toThrow();
    for (const key of ["role", "content", "timestamp"]) {
      const missing = { ...message } as Record<string, unknown>;
      delete missing[key];
      expect(() => validateMessage(missing)).toThrow("Invalid message record");
    }
  }
  for (const value of invalidValues) expect(() => validateMessage(value)).toThrow("Invalid message record");
  const invalidMessages = [
    { ...messages[2], sections: { a: false } },
    { ...messages[2], toolsAdded: [{ name: "write", description: "write", parameters: false }] },
    { ...messages[2], toolsRemoved: [{ name: false }] },
    { ...messages[3], stopReason: "unknown" },
    { ...messages[3], usage: { ...usage, input: "10" } },
    { ...messages[3], usage: { ...usage, cost: { ...usage.cost, total: null } } },
    { ...messages[3], content: [{ type: "toolCall", id: "", name: "write", arguments: {} }] },
    { ...messages[3], content: [{ type: "toolCall", id: "id", name: "", arguments: {} }] },
    { ...messages[3], content: [{ type: "toolCall", id: "id", name: "write", arguments: [] }] },
    { ...messages[1], content: [{ type: "image", data: "data" }] },
    { ...messages[1], content: [{ type: "text", text: false }] },
    { ...messages[4], isError: "false" },
  ];
  for (const value of invalidMessages) {
    expect(() => validateMessage(value)).toThrow("Invalid message record");
    expect(isSessionEntry({ ...common, type: "message", message: value })).toBe(false);
  }
});
