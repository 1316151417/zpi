import type { Message } from "ZPI-ai";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { SessionEntry, SessionHeader } from "./session-manager.ts";

/** Canonicalize reserved names from older transcripts without rewriting their files. */
export function normalizeSessionRecord(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const row = value as Record<string, unknown>;
  if (row.type === "session" && typeof row.format === "string" && row.format.toUpperCase() === "ZPI")
    return { ...row, format: "ZPI" };
  if (row.type === "custom" && typeof row.customType === "string")
    return { ...row, customType: row.customType.replace(/^ZPI\./i, "ZPI.") };
  if (row.type === "message" && row.message && typeof row.message === "object") {
    const message = row.message as Record<string, unknown>;
    if (message.role === "system" && message.sections && typeof message.sections === "object")
      return {
        ...row,
        message: {
          ...message,
          sections: Object.fromEntries(
            Object.entries(message.sections).map(([key, section]) => [
              key.replace(/^ZPI\./i, "ZPI."),
              section,
            ]),
          ),
        },
      };
  }
  return value;
}

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
  format: Type.Literal("ZPI"),
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
      type: Type.Literal("compaction"),
      summary: Type.String(),
      firstKeptEntryId: Type.String(),
      tokensBefore: Type.Optional(Type.Number()),
      details: Type.Optional(
        Type.Object({ readFiles: Type.Array(Type.String()), modifiedFiles: Type.Array(Type.String()) }),
      ),
      usage: Type.Optional(usage),
      systemMessage: Type.Optional(systemMessage),
    }),
    // Legacy read compatibility only; replay ignores this entry.
    Type.Object({
      type: Type.Literal("goal_change"),
      goal: Type.Union([
        Type.Null(),
        Type.Object({
          text: Type.String(),
          status: Type.Union([Type.Literal("active"), Type.Literal("paused"), Type.Literal("completed")]),
          updatedAt: Type.Number(),
          reason: Type.Optional(Type.String()),
        }),
      ]),
    }),
  ]),
]);
export function isSessionHeader(value: unknown): value is SessionHeader {
  return Check(header, value);
}
export function isSessionEntry(value: unknown): value is SessionEntry {
  return Check(entry, value);
}
export function validateMessage(value: unknown): asserts value is Message {
  if (!Check(message, value)) throw new Error("Invalid message record");
}
