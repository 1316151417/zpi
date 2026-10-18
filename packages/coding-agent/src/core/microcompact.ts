import { estimateMessageTokens, type Message } from "zpi-ai";

export const MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE = "[Old tool result content cleared]";
export const DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS = 5;
export const DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES = 60;
export const DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS = 256;
export const DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS = [
  "Read",
  "Bash",
  "Grep",
  "Glob",
  "WebFetch",
  "WebSearch",
  "Edit",
  "Write",
  "ApplyPatch",
] as const;
export interface MicrocompactConfig {
  enabled?: boolean;
  thresholdTokens?: number;
  idleThresholdMinutes?: number;
  keepRecentToolResults?: number;
  compactableToolNames?: readonly string[];
  clearErrorResults?: boolean;
  minTokenSavings?: number;
}
export interface MicrocompactBoundary {
  trigger: "time_based" | "token_pressure";
  strategy: "local_tool_result_clear";
  preMicrocompactTokenCount: number;
  postMicrocompactTokenCount: number;
  tokensSaved: number;
  clearedMessageCount: number;
  clearedToolCallIds: string[];
  keptToolCallIds: string[];
}
export function buildDefaultMicrocompactThreshold(autoCompactThreshold: number): number {
  return Math.max(0, Math.min(Math.floor(autoCompactThreshold * 0.9), autoCompactThreshold - 2000));
}
function nonnegative(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}
export function applyMicrocompactBoundary(
  messages: Message[],
  clearedToolCallIds: readonly string[],
): Message[] {
  if (!clearedToolCallIds.length) return messages;
  const cleared = new Set(clearedToolCallIds);
  return messages.map((message) =>
    message.role === "toolResult" && cleared.has(message.toolCallId)
      ? { ...message, content: [{ type: "text", text: MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE }] }
      : message,
  );
}
export function maybeMicrocompact(input: {
  messages: Message[];
  config?: MicrocompactConfig;
  lastAssistantCompletedAtMs?: number;
  nowMs?: number;
}): { messages: Message[]; boundary?: MicrocompactBoundary } {
  const { messages } = input;
  const config = input.config ?? {};
  // Runtime defaults OFF; opting in is required even though the upstream pure function defaults on.
  if (config.enabled !== true) return { messages };
  const pre = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const idle = nonnegative(config.idleThresholdMinutes, DEFAULT_MICROCOMPACT_IDLE_THRESHOLD_MINUTES);
  const trigger =
    input.lastAssistantCompletedAtMs !== undefined &&
    Number.isFinite(input.lastAssistantCompletedAtMs) &&
    (input.nowMs ?? Date.now()) - input.lastAssistantCompletedAtMs > idle * 60_000
      ? "time_based"
      : config.thresholdTokens !== undefined && pre >= config.thresholdTokens
        ? "token_pressure"
        : undefined;
  if (!trigger) return { messages };
  const tools = new Set(config.compactableToolNames ?? DEFAULT_MICROCOMPACT_COMPACTABLE_TOOLS);
  const groups: string[][] = [];
  let current: string[] | undefined;
  for (const message of messages) {
    if (message.role === "assistant" && message.content.some((block) => block.type === "toolCall")) {
      current = [];
      groups.push(current);
      continue;
    }
    if (message.role !== "toolResult" || !message.toolCallId || !message.toolName) continue;
    // ZPI's built-ins use lower-case Pi names; the upstream whitelist uses title-case names.
    if (
      !tools.has(message.toolName) &&
      !tools.has(message.toolName[0]?.toUpperCase() + message.toolName.slice(1))
    )
      continue;
    if (message.isError && config.clearErrorResults !== true) continue;
    // Microcompact never clears media, including extension-provided video or file blocks.
    if (message.content.some((block: { type: string }) => ["image", "video", "file"].includes(block.type)))
      continue;
    if (
      message.content.length === 1 &&
      message.content[0]?.type === "text" &&
      message.content[0].text === MICROCOMPACT_CLEARED_TOOL_RESULT_MESSAGE
    )
      continue;
    if (current) current.push(message.toolCallId);
    else groups.push([message.toolCallId]);
  }
  const candidates = groups.filter((group) => group.length > 0);
  const split = Math.max(
    0,
    candidates.length -
      Math.max(1, nonnegative(config.keepRecentToolResults, DEFAULT_MICROCOMPACT_KEEP_RECENT_TOOL_RESULTS)),
  );
  const clearedToolCallIds = candidates.slice(0, split).flat();
  if (!clearedToolCallIds.length) return { messages };
  const projected = applyMicrocompactBoundary(messages, clearedToolCallIds);
  const post = projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const tokensSaved = Math.max(0, pre - post);
  if (tokensSaved < nonnegative(config.minTokenSavings, DEFAULT_MICROCOMPACT_MIN_TOKEN_SAVINGS))
    return { messages };
  return {
    messages: projected,
    boundary: {
      trigger,
      strategy: "local_tool_result_clear",
      preMicrocompactTokenCount: pre,
      postMicrocompactTokenCount: post,
      tokensSaved,
      clearedMessageCount: clearedToolCallIds.length,
      clearedToolCallIds,
      keptToolCallIds: candidates.slice(split).flat(),
    },
  };
}

export function microcompactClearedIds(entry: { type: string; data?: unknown }): string[] {
  if (entry.type !== "microcompact" || !entry.data || typeof entry.data !== "object") return [];
  const ids = (entry.data as { clearedToolCallIds?: unknown }).clearedToolCallIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
}
