import type { DesktopEventEnvelope } from "zpi-ui";

export const eventBatchIntervalMs = 30;
export const eventBatchMaxEvents = 256;
/** UTF-16 content budget; envelopes and a single oversized event are counted separately. */
export const eventBatchMaxChars = 128 * 1024;

export function streamEventChars(envelope: DesktopEventEnvelope): number {
  return envelope.event.type === "block_delta" ? envelope.event.delta.length : 0;
}

/** Apply only after the recipient's snapshot watermark is known. */
export function coalesceSessionEvents(
  events: readonly DesktopEventEnvelope[],
  baseSeq: (sessionId: string) => number,
): DesktopEventEnvelope[] {
  const result: DesktopEventEnvelope[] = [];
  const seen = new Map<string, number>();
  let previousFresh = false;
  for (const envelope of events) {
    const watermark = seen.get(envelope.sessionId) ?? baseSeq(envelope.sessionId);
    const fresh = envelope.seq > watermark;
    seen.set(envelope.sessionId, Math.max(watermark, envelope.seq));
    const previous = result.at(-1);
    const event = envelope.event;
    if (
      event.type === "block_delta" &&
      fresh &&
      previousFresh &&
      previous?.event.type === "block_delta" &&
      previous.activityAt === undefined &&
      envelope.activityAt === undefined &&
      previous.sessionId === envelope.sessionId &&
      previous.runId === envelope.runId &&
      previous.seq + 1 === envelope.seq &&
      previous.event.messageId === event.messageId &&
      previous.event.contentIndex === event.contentIndex
    ) {
      // 只合并快照之后的相邻追加；跨水位拼接会让快照已经包含的前缀被重复追加。
      result[result.length - 1] = {
        ...envelope,
        event: { ...event, delta: previous.event.delta + event.delta },
      };
    } else result.push(envelope);
    previousFresh = fresh;
  }
  return result;
}
