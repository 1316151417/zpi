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

/** Count only protocol cache locations, never user/tool input objects with similarly named fields. */
export function assertProviderCacheControlLimit(request: {
  system?: unknown;
  tools?: unknown;
  messages?: unknown;
}): void {
  const count = (items: unknown): number =>
    !Array.isArray(items)
      ? 0
      : items.reduce((total, item: unknown) => {
          if (!item || typeof item !== "object") return total;
          const block = item as { cache_control?: unknown; content?: unknown };
          return total + (block.cache_control === undefined ? 0 : 1) + count(block.content);
        }, 0);
  const breakpoints = count(request.system) + count(request.tools) + count(request.messages);
  if (breakpoints > 4)
    throw new Error(
      `Anthropic requests support at most 4 cache_control breakpoints; received ${breakpoints}.`,
    );
}
