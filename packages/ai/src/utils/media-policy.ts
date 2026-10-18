import type { ImageContent, Model, TranscriptContext } from "../types.ts";

export const DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES = 40 * 1024 * 1024;
export const MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE = "MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE";
interface ContentBlock {
  type: string;
  text?: string;
  mimeType?: string;
  mediaType?: string;
  name?: string;
  data?: string;
  dataUrl?: string;
}
interface MediaMessage {
  role: string;
  content: string | readonly ContentBlock[];
  /** Synthetic summaries/reminders must not acquire current-user attachment protection. */
  synthetic?: boolean;
}
export interface MediaBudgetStats {
  omittedMediaCount: number;
  projectedMediaBytes: number;
  retainedMediaCount: number;
  totalMediaBytes: number;
  evictionFrontier: { messageIndex: number; blockIndex: number } | null;
}
export class MediaBudgetError extends Error {
  readonly code = MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE;
  readonly type = "InvalidInput";
  readonly recoverable = true;
  readonly context: { maxMediaBytes: number; protectedMediaBytes: number; totalMediaBytes: number };
  constructor(context: { maxMediaBytes: number; protectedMediaBytes: number; totalMediaBytes: number }) {
    super(
      `${MEDIA_BUDGET_CURRENT_ATTACHMENT_TOO_LARGE}: Current attachments are too large to send. Remove or compress attachments and try again.`,
    );
    this.context = context;
  }
}
export function mediaBlockToText(block: ContentBlock): string {
  return `[Attached ${block.mimeType ?? block.mediaType ?? block.type}${block.name ? `: ${block.name}` : ""}]`;
}
/** UTF-8 size without Node globals or allocating an encoded copy of large media strings. */
function utf8ByteLength(value: string): number {
  let bytes = value.length;
  const firstNonAscii = value.search(/[\u0080-\uffff]/);
  if (firstNonAscii < 0) return bytes;
  for (let index = firstNonAscii; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x7f) continue;
    if (code <= 0x7ff) bytes++;
    else {
      bytes += 2;
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = value.charCodeAt(index + 1);
        if (next >= 0xdc00 && next <= 0xdfff) index++;
      }
    }
  }
  return bytes;
}
export function mediaRequestBytes(block: ContentBlock): number {
  if (block.type !== "image" && block.type !== "video" && !(block.type === "file" && !block.text)) return 0;
  if (block.dataUrl !== undefined && block.dataUrl !== "") return utf8ByteLength(block.dataUrl);
  if (block.dataUrl === undefined && block.data !== undefined)
    return utf8ByteLength(`data:${block.mimeType};base64,`) + utf8ByteLength(block.data);
  // Only inline payloads are supported. A future source.uri image needs an explicit
  // request policy; silently counting a missing payload as zero would bypass this budget.
  if (block.type === "image" || block.type === "video")
    throw new Error("MEDIA_PAYLOAD_MISSING: Inline media requires data or dataUrl.");
  return 0;
}
export function omittedMediaBlock(block: ContentBlock) {
  // Byte-stable provider history: editing this text invalidates cached prefixes.
  return {
    type: "text" as const,
    text: `${mediaBlockToText(block)}\n[Media omitted from provider request to keep the request body under the configured media budget.]`,
  };
}

/** Request-only projection: original transcript, artifacts and tool results remain untouched. */
export function projectMessagesForMediaBudget<T extends MediaMessage>(
  messages: T[],
  options: {
    maxMediaBytes?: number;
    latestRealUserMessageIndex?: number;
    preserveLatestUserMedia?: boolean;
  } = {},
): { messages: T[] } & MediaBudgetStats {
  const maxMediaBytes = options.maxMediaBytes ?? DEFAULT_MODEL_REQUEST_MEDIA_BUDGET_BYTES;
  if (!Number.isFinite(maxMediaBytes) || maxMediaBytes < 0)
    throw new Error("Invalid model request media budget");
  const latestUserIndex =
    options.preserveLatestUserMedia === false
      ? -1
      : options.latestRealUserMessageIndex !== undefined &&
          Number.isInteger(options.latestRealUserMessageIndex) &&
          options.latestRealUserMessageIndex >= -1 &&
          options.latestRealUserMessageIndex < messages.length
        ? options.latestRealUserMessageIndex
        : messages.findLastIndex((message) => message.role === "user" && message.synthetic !== true);
  const media = messages.flatMap((message, messageIndex) =>
    typeof message.content === "string"
      ? []
      : message.content.flatMap((block, blockIndex) => {
          const requestBytes = mediaRequestBytes(block);
          return requestBytes ? [{ messageIndex, blockIndex, requestBytes }] : [];
        }),
  );
  const totalMediaBytes = media.reduce((sum, item) => sum + item.requestBytes, 0);
  const stats: MediaBudgetStats = {
    omittedMediaCount: 0,
    projectedMediaBytes: totalMediaBytes,
    retainedMediaCount: media.length,
    totalMediaBytes,
    evictionFrontier: null,
  };
  if (totalMediaBytes <= maxMediaBytes) return { messages, ...stats };
  const protectedMedia = media.filter((item) => item.messageIndex === latestUserIndex);
  const protectedMediaBytes = protectedMedia.reduce((sum, item) => sum + item.requestBytes, 0);
  if (protectedMediaBytes > maxMediaBytes)
    throw new MediaBudgetError({ maxMediaBytes, protectedMediaBytes, totalMediaBytes });
  const key = (item: { messageIndex: number; blockIndex: number }) =>
    `${item.messageIndex}:${item.blockIndex}`;
  const retained = new Set(protectedMedia.map(key));
  let remaining = maxMediaBytes - protectedMediaBytes;
  // Approved ZCode deviation: break instead of continue gives a continuous newest suffix.
  // Equal-size screenshot batches retain the same floor(B/S) items. Under append-only history
  // and a fixed protection set, old images cannot revive; the single frontier enables later
  // hysteresis/window policies. This buys predictability, not improved cache hit rates.
  // Cost: smaller older images behind a large image are also dropped (retained is a subset
  // of continue's result). A new user attachment changes protection: monotonicity only holds
  // inside one agent loop, never across arbitrary user turns.
  for (const item of media.filter((item) => item.messageIndex !== latestUserIndex).reverse()) {
    if (item.requestBytes > remaining) {
      stats.evictionFrontier = { messageIndex: item.messageIndex, blockIndex: item.blockIndex };
      break;
    }
    retained.add(key(item));
    remaining -= item.requestBytes;
  }
  stats.omittedMediaCount = media.length - retained.size;
  stats.retainedMediaCount = retained.size;
  stats.projectedMediaBytes = maxMediaBytes - remaining;
  const omitted = new Set(media.filter((item) => !retained.has(key(item))).map(key));
  // Recomputed from canonical history every request: no persistence, idle gate, minimum
  // savings, low-water mark or hysteresis. Evicting an early image invalidates the prefix
  // from there. Read's 200,000-byte intake makes eviction rare, but does not solve KV caching.
  // Only media data URLs are counted; text, tools and JSON mean 40 MiB cannot bound HTTP body size.
  return {
    ...stats,
    messages: messages.map((message, messageIndex) =>
      typeof message.content === "string"
        ? message
        : {
            ...message,
            content: message.content.map((block, blockIndex) =>
              omitted.has(key({ messageIndex, blockIndex })) ? omittedMediaBlock(block) : block,
            ),
          },
    ) as T[],
  };
}

/** Always bind capability projection and aggregate budget at the same provider request boundary. */
export function projectContextForModelMediaPolicy(
  context: TranscriptContext,
  model: Pick<Model, "input">,
  options: { maxMediaBytes?: number; onProjection?: (stats: MediaBudgetStats) => void } = {},
): TranscriptContext {
  const capable = model.input.includes("image")
    ? context.messages
    : context.messages.map((message) => {
        if (
          (message.role !== "user" && message.role !== "toolResult") ||
          typeof message.content === "string" ||
          !message.content.some((block) => block.type === "image")
        )
          return message;
        return {
          ...message,
          content: message.content.map((block) =>
            block.type === "image"
              ? { type: "text" as const, text: mediaBlockToText(block as ImageContent) }
              : block,
          ),
        };
      });
  const { messages, ...stats } = projectMessagesForMediaBudget(capable, options);
  if (stats.omittedMediaCount) options.onProjection?.(stats);
  return messages === context.messages ? context : { ...context, messages };
}

/** Compact retries use their own short placeholders, never the aggregate-budget omission text. */
export function projectCompactMediaForRetry<T extends MediaMessage>(
  messages: T[],
): { messages: T[]; replacedMediaCount: number } {
  let replacedMediaCount = 0;
  const projected = messages.map((message) =>
    typeof message.content === "string"
      ? message
      : {
          ...message,
          content: message.content.map((block) => {
            if (
              block.type === "image" ||
              block.type === "video" ||
              (block.type === "file" &&
                !block.text &&
                (block.dataUrl !== undefined || block.data !== undefined))
            ) {
              replacedMediaCount++;
              return { type: "text", text: block.type === "file" ? "[document]" : `[${block.type}]` };
            }
            return block;
          }),
        },
  ) as T[];
  return { messages: projected, replacedMediaCount };
}
