import type { AssistantMessageEvent, ModelPerformanceSample, StreamOptions } from "../types.ts";
import { AssistantMessageEventStream } from "./event-stream.ts";

/** Measures at the producer, before consumers, tool execution or backpressure can delay events. */
export class MeasuredAssistantStream extends AssistantMessageEventStream {
  private started?: number;
  private first?: number;
  private last?: number;
  private firstText?: number;
  private lastText?: number;
  private textChunks = 0;
  private textChars = 0;
  private currentTextChunk = 0;
  private largestTextChunk = 0;
  private hasThinking = false;
  private hasToolCalls = false;
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
    this.firstText = this.lastText = undefined;
    this.textChunks = this.textChars = this.currentTextChunk = this.largestTextChunk = 0;
    this.hasThinking = this.hasToolCalls = false;
    this.contentVersion = 0;
    this.usageVersion = -1;
    this.sample = {};
    this.publish();
  }
  /** All deltas decoded from one wire event share one arrival time. */
  received(): void {
    this.receivedAt = this.now();
  }
  generated(kind: "text" | "thinking" | "tool" = "tool", chars = 0): void {
    if (this.started === undefined) return;
    this.last = this.receivedAt ?? this.now();
    this.contentVersion++;
    if (kind === "tool") this.hasToolCalls = true;
    if (kind === "thinking") this.hasThinking = true;
    if (kind === "text" && chars > 0) {
      if (this.lastText !== this.last) {
        this.textChunks++;
        this.currentTextChunk = 0;
      }
      this.currentTextChunk += chars;
      this.largestTextChunk = Math.max(this.largestTextChunk, this.currentTextChunk);
      this.textChars += chars;
      this.firstText ??= this.last;
      this.lastText = this.last;
    }
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
      this.generated(
        event.type === "text_delta" ? "text" : event.type === "thinking_delta" ? "thinking" : "tool",
        event.delta.length,
      );
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
        this.generated(
          block.type === "text" ? "text" : block.type === "thinking" ? "thinking" : "tool",
          block.type === "text" ? block.text.length : 0,
        );
      if (block?.type === "thinking") this.hasThinking = true;
    }
    if (event.type === "done") {
      if (this.usageVersion !== this.contentVersion) {
        // A partial count must never become a final speed after additional content arrived.
        this.sample = { ttftMs: this.sample.ttftMs };
      }
      this.sample.requestMs = this.started === undefined ? undefined : this.now() - this.started;
      if (this.started !== undefined) {
        this.sample.firstTextMs = this.firstText === undefined ? undefined : this.firstText - this.started;
        this.sample.textGenerationMs =
          this.firstText === undefined || this.lastText === undefined
            ? undefined
            : this.lastText - this.firstText;
        this.sample.textChunks = this.textChunks;
        this.sample.textChars = this.textChars;
        this.sample.largestTextChunk = this.largestTextChunk;
        this.sample.hasThinking = this.hasThinking;
        this.sample.hasToolCalls = this.hasToolCalls;
      }
      this.publish();
    }
    super.push(event);
  }
  private publish(): void {
    if (!this.options.signal?.aborted) this.options.onPerformance?.({ ...this.sample });
  }
}
