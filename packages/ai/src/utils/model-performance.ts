import type { AssistantMessageEvent, ModelPerformanceSample, StreamOptions } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

/** Measures at the producer, before consumers, tool execution or backpressure can delay events. */
export class MeasuredAssistantStream extends AssistantMessageEventStream {
  private started?: number;
  private first?: number;
  private last?: number;
  private contentVersion = 0;
  private receivedAt?: number;
  private usageVersion = -1;
  private sample: ModelPerformanceSample = {};
  private options: StreamOptions;
  private now: () => number;
  constructor(options: StreamOptions = {}, now = () => performance.now()) {
    super();
    this.options = options;
    this.now = now;
  }
  startRequest(): void {
    this.started = this.now();
    this.receivedAt = undefined;
    this.first = this.last = undefined;
    this.contentVersion = 0;
    this.usageVersion = -1;
    this.sample = {};
    this.publish();
  }
  /** All deltas decoded from one wire event share one arrival time. */
  received(): void {
    this.receivedAt = this.now();
  }
  generated(): void {
    if (this.started === undefined) return;
    this.last = this.receivedAt ?? this.now();
    this.contentVersion++;
    if (this.first !== undefined) return;
    this.first = this.last;
    const ttftMs = this.first - this.started;
    if (Number.isFinite(ttftMs) && ttftMs > 0) this.sample.ttftMs = ttftMs;
    this.publish();
  }
  /** Call only when a fresh cumulative output count arrives, after content from the same wire event. */
  recordUsage(outputTokens: unknown): void {
    const generationMs = this.first === undefined || this.last === undefined ? 0 : this.last - this.first;
    const valid = typeof outputTokens === "number" && Number.isSafeInteger(outputTokens) && outputTokens > 0;
    this.sample = {
      ...this.sample,
      outputTokens: valid ? outputTokens : undefined,
      generationMs: valid && generationMs > 0 ? generationMs : undefined,
    };
    this.usageVersion = this.contentVersion;
    this.publish();
  }
  override push(event: AssistantMessageEvent): void {
    if (
      (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") &&
      event.delta.length > 0
    )
      this.generated();
    else if (
      event.type === "text_start" ||
      event.type === "thinking_start" ||
      event.type === "toolcall_start"
    ) {
      const block = event.partial.content[event.contentIndex];
      if (
        (block?.type === "text" && block.text.length > 0) ||
        (block?.type === "thinking" && !block.redacted && block.thinking.length > 0) ||
        (block?.type === "toolCall" && block.name.length > 0)
      )
        this.generated();
    }
    if (event.type === "done") {
      if (this.usageVersion !== this.contentVersion) {
        // A partial count must never become a final speed after additional content arrived.
        this.sample = { ttftMs: this.sample.ttftMs };
      }
      this.sample.requestMs = this.started === undefined ? undefined : this.now() - this.started;
      this.publish();
    }
    super.push(event);
  }
  private publish(): void {
    if (!this.options.signal?.aborted) this.options.onPerformance?.({ ...this.sample });
  }
}
