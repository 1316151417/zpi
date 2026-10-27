import type { DesktopEventEnvelope } from "zpi-ui";
import {
  eventBatchIntervalMs,
  eventBatchMaxChars,
  eventBatchMaxEvents,
  streamEventChars,
} from "../shared/event-batches.ts";

/** Bounded pending transport buffer. Host projection and persistence remain authoritative. */
export class EventBatcher {
  private events: DesktopEventEnvelope[] = [];
  private chars = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private closed = false;
  private send: (events: DesktopEventEnvelope[]) => void;

  constructor(send: (events: DesktopEventEnvelope[]) => void) {
    this.send = send;
  }

  push(envelope: DesktopEventEnvelope): void {
    if (this.closed) return;
    const chars = streamEventChars(envelope);
    // Structural events are ordering barriers, and must not wait for the stream timer.
    if (envelope.event.type !== "block_delta" || chars >= eventBatchMaxChars) {
      this.flush();
      this.send([envelope]);
      return;
    }
    if (this.events.length >= eventBatchMaxEvents || this.chars + chars > eventBatchMaxChars) this.flush();
    this.events.push(envelope);
    this.chars += chars;
    if (this.events.length >= eventBatchMaxEvents || this.chars >= eventBatchMaxChars) this.flush();
    else this.timer ??= setTimeout(() => this.flush(), eventBatchIntervalMs);
  }

  flush(): void {
    const events = this.events;
    this.clear();
    if (events.length) this.send(events);
  }

  clear(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.events = [];
    this.chars = 0;
  }

  close(): void {
    this.clear();
    this.closed = true;
  }
}
