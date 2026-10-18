import type { Message } from "../types.ts";

/** System breakpoints are independent; replace only non-system markers on a request copy. */
export function finalizeProviderCacheControl(
  messages: Message[],
  options: { skipCacheWrite?: boolean } = {},
): Message[] {
  const indexes = messages.flatMap((message, index) => (message.role === "system" ? [] : [index]));
  const tail = indexes.at(options.skipCacheWrite ? -2 : -1);
  return messages.map((message, index) => {
    if (message.role === "system") return message;
    const { cacheControl: _, ...rest } = message;
    return index === tail ? { ...rest, cacheControl: { type: "ephemeral" as const } } : rest;
  });
}
