// Adapted from Pi (commit c20cb09772bf4e2590a316cb54514cef76df4293) Copyright (c) 2025 Mario Zechner. MIT license
import type { AssistantMessage, Message } from "../types.ts";
import { getCurrentSystemPrompt, getCurrentTools } from "./transcript.ts";

export interface ContextUsageAnchor {
  chars: number;
  inputTokens: number;
}
/** Pi's text/image heuristic; image bytes never count as text. */
export function messageChars(message: Message): number {
  if (typeof message.content === "string") return message.content.length;
  return message.content.reduce((chars, block) => {
    if (block.type === "image") return chars + 4800;
    if (block.type === "text") return chars + block.text.length;
    if (block.type === "thinking") return chars + block.thinking.length;
    return chars + block.name.length + JSON.stringify(block.arguments).length;
  }, 0);
}
export function contextChars(messages: readonly Message[]): number {
  return (
    getCurrentSystemPrompt([...messages]).length +
    JSON.stringify(getCurrentTools([...messages])).length +
    messages.reduce((n, message) => n + (message.role === "system" ? 0 : messageChars(message)), 0)
  );
}
export function usageAnchor(
  messages: readonly Message[],
  result: AssistantMessage,
): ContextUsageAnchor | undefined {
  const inputTokens = result.usage.input + result.usage.cacheRead + result.usage.cacheWrite;
  if (result.usageAvailable === false || inputTokens <= 0 || ["error", "aborted"].includes(result.stopReason))
    return undefined;
  return { chars: Math.max(1, contextChars(messages)), inputTokens };
}
export function estimateContextTokens(messages: readonly Message[], anchor?: ContextUsageAnchor): number {
  const chars = contextChars(messages);
  return Math.ceil(
    anchor ? anchor.inputTokens + ((chars - anchor.chars) * anchor.inputTokens) / anchor.chars : chars / 4,
  );
}
/** A new system section/summary invalidates usage from an older prefix. */
export function restoreUsageAnchor(messages: readonly Message[]): ContextUsageAnchor | undefined {
  let anchor: ContextUsageAnchor | undefined;
  let latestPrefix = -Infinity;
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "system") anchor = undefined;
    if (message.role === "assistant" && message.timestamp >= latestPrefix)
      anchor = usageAnchor(messages.slice(0, i), message) ?? anchor;
    latestPrefix = Math.max(latestPrefix, message.timestamp);
  }
  return anchor;
}
