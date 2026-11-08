import type { Message } from "@zpi-dev/ai";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import type { SessionEntry, SessionHeader } from "./session-manager.ts";

export const maxSessionEntryBytes = 8 * 1024 * 1024;

const text = Type.Object({ type: Type.Literal("text"), text: Type.String() });
const image = Type.Object({ type: Type.Literal("image"), data: Type.String(), mimeType: Type.String() });
const thinking = Type.Object({ type: Type.Literal("thinking"), thinking: Type.String() });
const object = Type.Object({}, { additionalProperties: true });
const call = Type.Object({
  type: Type.Literal("toolCall"),
  id: Type.String({ minLength: 1 }),
  name: Type.String({ minLength: 1 }),
  arguments: object,
});
const tool = Type.Object({ name: Type.String(), description: Type.String(), parameters: object });
const rates = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
});
const usage = Type.Object({
  input: Type.Number(),
  output: Type.Number(),
  cacheRead: Type.Number(),
  cacheWrite: Type.Number(),
  totalTokens: Type.Number(),
  cost: Type.Intersect([rates, Type.Object({ total: Type.Number() })]),
});
const systemMessage = Type.Object({
  role: Type.Literal("system"),
  content: Type.Union([Type.String(), Type.Array(text)]),
  timestamp: Type.Number(),
  sections: Type.Optional(Type.Record(Type.String(), Type.Union([Type.String(), Type.Null()]))),
  toolsAdded: Type.Optional(Type.Array(tool)),
  toolsRemoved: Type.Optional(Type.Array(Type.Object({ name: Type.String() }))),
});
const message = Type.Union([
  systemMessage,
  Type.Object({
    role: Type.Literal("user"),
    content: Type.Union([Type.String(), Type.Array(Type.Union([text, image]))]),
    timestamp: Type.Number(),
  }),
  Type.Object({
    role: Type.Literal("assistant"),
    content: Type.Array(Type.Union([text, thinking, call])),
    api: Type.String(),
    provider: Type.String(),
    model: Type.String(),
    timestamp: Type.Number(),
    usage,
    stopReason: Type.Union([
      Type.Literal("stop"),
      Type.Literal("length"),
      Type.Literal("toolUse"),
      Type.Literal("aborted"),
      Type.Literal("error"),
    ]),
  }),
  Type.Object({
    role: Type.Literal("toolResult"),
    toolCallId: Type.String(),
    toolName: Type.String(),
    content: Type.Array(Type.Union([text, image])),
    isError: Type.Boolean(),
    timestamp: Type.Number(),
  }),
]);
const header = Type.Object({
  type: Type.Literal("session"),
  version: Type.Literal(1),
  format: Type.Literal("zpi"),
  id: Type.String({ pattern: "^[a-zA-Z0-9_-]+$" }),
  timestamp: Type.String(),
  cwd: Type.String(),
});
const level = Type.String({ minLength: 1, maxLength: 128, pattern: "\\S" });
const entry = Type.Intersect([
  Type.Object({
    id: Type.String(),
    parentId: Type.Union([Type.String(), Type.Null()]),
    timestamp: Type.String(),
  }),
  Type.Union([
    Type.Object({ type: Type.Literal("message"), message }),
    Type.Object({ type: Type.Literal("model_change"), provider: Type.String(), modelId: Type.String() }),
    Type.Object({ type: Type.Literal("thinking_level_change"), thinkingLevel: level }),
    Type.Object({ type: Type.Literal("session_info"), name: Type.String() }),
    Type.Object({ type: Type.Literal("custom"), customType: Type.String() }),
    Type.Object({
      type: Type.Literal("microcompact"),
      data: Type.Object({
        trigger: Type.Union([Type.Literal("time_based"), Type.Literal("token_pressure")]),
        strategy: Type.Literal("local_tool_result_clear"),
        preMicrocompactTokenCount: Type.Number(),
        postMicrocompactTokenCount: Type.Number(),
        tokensSaved: Type.Number(),
        clearedMessageCount: Type.Number(),
        clearedToolCallIds: Type.Array(Type.String()),
        keptToolCallIds: Type.Array(Type.String()),
      }),
    }),
    Type.Object({
      type: Type.Literal("compaction"),
      summary: Type.String(),
      firstKeptEntryId: Type.String(),
      tokensBefore: Type.Optional(Type.Number()),
      details: Type.Optional(
        Type.Object({ readFiles: Type.Array(Type.String()), modifiedFiles: Type.Array(Type.String()) }),
      ),
      usage: Type.Optional(usage),
      systemMessage: Type.Optional(systemMessage),
      contextMessage: Type.Optional(systemMessage),
    }),
  ]),
]);
// Compile the fixed schemas once; keep exactly the same validation at every public boundary.
const headerValidator = Compile(header);
const entryValidator = Compile(entry);
const messageValidator = Compile(message);
export function isSessionHeader(value: unknown): value is SessionHeader {
  return headerValidator.Check(value);
}
export function isSessionEntry(value: unknown): value is SessionEntry {
  return entryValidator.Check(value);
}
/** Validate native records without repairing files or replaying tool journals. */
export function decodeSessionTranscript(records: readonly unknown[]): {
  header: SessionHeader;
  entries: SessionEntry[];
} {
  const header = records[0];
  if (!isSessionHeader(header)) throw new Error("Unsupported session header");
  let parent: string | null = null;
  const ids = new Set<string>();
  for (let i = 1; i < records.length; i++) {
    const entry = records[i];
    if (!isSessionEntry(entry) || ids.has(entry.id) || entry.parentId !== parent)
      throw new Error("Invalid session entry chain or content");
    ids.add(entry.id);
    parent = entry.id;
  }
  return { header, entries: records.slice(1) as SessionEntry[] };
}
/** Pure JSONL parsing; the writable owner decides whether to apply a tail repair. */
export function parseSessionTranscript(raw: string, options: { repairIncompleteTail?: boolean } = {}) {
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const records: unknown[] = [];
  let repairTo: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    try {
      if (Buffer.byteLength(lines[i]) > maxSessionEntryBytes) throw new Error("Session entry exceeds 8 MiB");
      records.push(JSON.parse(lines[i]));
    } catch (error) {
      if (!options.repairIncompleteTail || i !== lines.length - 1 || i === 0 || raw.endsWith("\n"))
        throw new Error(`Corrupt session at line ${i + 1}: ${String(error)}`);
      repairTo = `${lines.slice(0, i).join("\n")}\n`;
    }
  }
  return { ...decodeSessionTranscript(records), repairTo };
}
export function validateMessage(value: unknown): asserts value is Message {
  if (!messageValidator.Check(value)) throw new Error("Invalid message record");
}
