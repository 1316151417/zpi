import { isJsonObject, type JsonValue } from "zpi-ai";
import { isSessionEntry, type SessionEntry, type SessionHeader } from "zpi-coding-agent";

export interface TranscriptHeader extends Omit<SessionHeader, "version"> {
  version: 2;
  generation: string;
}
const factTypes: Record<string, string> = {
  "zpi.run": "run",
  "zpi.agent_call": "call",
  "zpi.streaming_tools": "tool_journal",
  "zpi.compaction": "notice",
  "zpi.notice": "diagnostic",
  "zpi.context_boundary": "context_anchor",
};
export function validateTranscriptHeader(value: unknown): TranscriptHeader {
  if (
    !isJsonObject(value) ||
    value.type !== "session" ||
    value.format !== "zpi" ||
    value.version !== 2 ||
    typeof value.id !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(value.id) ||
    typeof value.cwd !== "string" ||
    typeof value.timestamp !== "string" ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.generation !== "string" ||
    !value.generation
  )
    throw new Error("storage: Expected transcript v2; migrate legacy data offline");
  return value as unknown as TranscriptHeader;
}
/** UI/core adapters may use SessionEntry; only semantic v2 records reach disk. */
export function validateTranscriptEntry(value: unknown): SessionEntry {
  if (!isSessionEntry(value)) throw new Error("storage: Invalid transcript entry");
  if (
    ["session_info", "model_change", "thinking_level_change"].includes(value.type) ||
    (value.type === "custom" && !Object.hasOwn(factTypes, value.customType))
  )
    throw new Error("storage: Product metadata is not a transcript fact");
  if (!value.id || !Number.isFinite(Date.parse(value.timestamp)))
    throw new Error("storage: Invalid transcript entry identity");
  if (value.type === "custom" && !isJsonObject(value.data))
    throw new Error("storage: Invalid transcript fact payload");
  if (value.type === "custom" && isJsonObject(value.data)) {
    const data = value.data;
    if (
      value.customType === "zpi.run" &&
      (typeof data.runId !== "string" ||
        !data.runId ||
        !["start", "accepted", "end"].includes(String(data.phase)))
    )
      throw new Error("storage: Invalid run fact");
    if (value.customType === "zpi.agent_call" && !["start", "end"].includes(String(data.phase)))
      throw new Error("storage: Invalid call fact");
    if (value.customType === "zpi.streaming_tools" && (typeof data.id !== "string" || !data.id))
      throw new Error("storage: Invalid tool journal fact");
    if (value.customType === "zpi.notice" && typeof data.text !== "string")
      throw new Error("storage: Invalid diagnostic fact");
  }
  if (value.type === "compaction" && !value.systemMessage)
    throw new Error("storage: Compaction requires a complete system snapshot");
  return value;
}
export function encodeTranscriptEntry(value: SessionEntry, seq: number): JsonValue {
  const entry = validateTranscriptEntry(value);
  if (!Number.isSafeInteger(seq) || seq < 1) throw new Error("storage: Invalid sequence");
  if (entry.type !== "custom") return { ...entry, seq } as unknown as JsonValue;
  return {
    id: entry.id,
    parentId: entry.parentId,
    timestamp: entry.timestamp,
    seq,
    type: factTypes[entry.customType],
    fact: entry.data ?? null,
  };
}
export function decodeTranscriptEntry(value: unknown): SessionEntry {
  if (!isJsonObject(value) || !Number.isSafeInteger(value.seq) || Number(value.seq) < 1)
    throw new Error("storage: Invalid v2 sequence");
  if (value.type === "message" || value.type === "compaction") return validateTranscriptEntry(value);
  const customType = Object.keys(factTypes).find((key) => factTypes[key] === value.type);
  if (!customType) throw new Error("storage: Unsupported v2 fact type");
  return validateTranscriptEntry({
    id: value.id,
    parentId: value.parentId,
    timestamp: value.timestamp,
    type: "custom",
    customType,
    data: value.fact,
  });
}
