import { createHash, randomUUID } from "node:crypto";
import {
  type AssistantMessage,
  contentText,
  isJsonObject,
  type Message,
  type Usage as NativeUsage,
} from "@zpi-dev/ai";
import type { SessionEntry } from "@zpi-dev/coding-agent";
import type { SDKAssistantMessage, SDKUserMessage, Usage } from "./types.ts";

export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
});
export function usage(value: NativeUsage): Usage {
  return {
    ...emptyUsage(),
    input_tokens: value.input,
    output_tokens: value.output,
    cache_creation_input_tokens: value.cacheWrite,
    cache_read_input_tokens: value.cacheRead,
  };
}
export function stableUuid(id: string): string {
  const h = createHash("sha256").update(id).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export function messageText(message: Message): string {
  return contentText(message.content);
}
export function assistantMessage(
  message: AssistantMessage,
  sessionId: string,
  uuid: string = randomUUID(),
  parent: string | null = null,
): SDKAssistantMessage {
  return {
    type: "assistant",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: parent,
    ...(message.stopReason === "error" ? { error: "unknown" as const } : {}),
    ...(message.stopReason === "aborted" ? { aborted: true as const } : {}),
    message: {
      id: `msg_${uuid}`,
      type: "message",
      role: "assistant",
      model: message.model,
      content: message.content.map((part) =>
        part.type === "text"
          ? { type: "text", text: part.text }
          : part.type === "thinking"
            ? { type: "thinking", thinking: part.thinking, signature: part.thinkingSignature ?? "" }
            : {
                type: "tool_use",
                id: part.id,
                name: part.name,
                input: part.arguments as Record<string, unknown>,
              },
      ),
      stop_reason:
        message.stopReason === "toolUse"
          ? "tool_use"
          : message.stopReason === "length"
            ? "max_tokens"
            : ["aborted", "error"].includes(message.stopReason)
              ? null
              : "end_turn",
      stop_sequence: null,
      usage: usage(message.usage),
    },
  };
}
export function userMessage(
  message: Extract<Message, { role: "user" | "toolResult" }>,
  sessionId: string,
  uuid: string,
  parent: string | null = null,
): SDKUserMessage {
  const content =
    typeof message.content === "string"
      ? message.content
      : message.content.map((part) =>
          part.type === "text"
            ? { type: "text" as const, text: part.text }
            : {
                type: "image" as const,
                source: { type: "base64" as const, media_type: part.mimeType, data: part.data },
              },
        );
  return {
    type: "user",
    uuid,
    session_id: sessionId,
    parent_tool_use_id: parent,
    message: {
      role: "user",
      content:
        message.role === "toolResult"
          ? [{ type: "tool_result", tool_use_id: message.toolCallId, content, is_error: message.isError }]
          : content,
    },
  };
}
export function messageUuids(entries: readonly SessionEntry[]): Map<string, string> {
  const ids = new Map<string, string>();
  // Legacy transcripts stored the client uuid in sdk.user side entries; inputId on the user
  // message itself replaces that association and the text match remains only as a fallback.
  let user: { uuid: string; text: string } | undefined;
  for (const entry of entries) {
    if (
      entry.type === "custom" &&
      entry.customType === "sdk.user" &&
      isJsonObject(entry.data) &&
      typeof entry.data.uuid === "string" &&
      typeof entry.data.text === "string"
    )
      user = { uuid: entry.data.uuid, text: entry.data.text };
    if (entry.type === "message") {
      const declared = entry.message.role === "user" ? entry.message.inputId : undefined;
      const legacy =
        !declared && entry.message.role === "user" && user && messageText(entry.message) === user.text;
      ids.set(entry.id, declared ?? (legacy && user ? user.uuid : stableUuid(entry.id)));
      if (declared || legacy) user = undefined;
    }
  }
  return ids;
}
