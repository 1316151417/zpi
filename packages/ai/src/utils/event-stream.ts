import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
/** Single-consumer protocol stream. The final result is independent of iteration. */
export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: (AssistantMessageEvent | undefined)[] = [];
  private head = 0;
  private waiter?: () => void;
  private ended = false;
  private resolveResult!: (message: AssistantMessage) => void;
  private finalResult = new Promise<AssistantMessage>((resolve) => {
    this.resolveResult = resolve;
  });
  push(event: AssistantMessageEvent): void {
    if (this.ended) return;
    this.queue.push(event);
    if (event.type === "done" || event.type === "error") {
      this.ended = true;
      this.resolveResult(event.type === "done" ? event.message : event.error);
    }
    this.waiter?.();
    this.waiter = undefined;
  }
  end(result?: AssistantMessage): void {
    if (this.ended) return;
    if (!result) throw new Error("An assistant stream must end with a final result");
    this.push(
      result.stopReason === "error" || result.stopReason === "aborted"
        ? { type: "error", reason: result.stopReason, error: result }
        : { type: "done", reason: result.stopReason, message: result },
    );
  }
  result(): Promise<AssistantMessage> {
    return this.finalResult;
  }
  async *[Symbol.asyncIterator](): AsyncIterator<AssistantMessageEvent> {
    while (true) {
      const next = this.queue[this.head];
      if (next) {
        // Clear consumed references without shifting every remaining event.
        this.queue[this.head++] = undefined;
        if (this.head === this.queue.length) {
          this.queue.length = 0;
          this.head = 0;
        } else if (this.head >= 1024 && this.head * 2 >= this.queue.length) {
          this.queue = this.queue.slice(this.head);
          this.head = 0;
        }
        yield next;
        continue;
      }
      if (this.ended) return;
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
    }
  }
}
export function createAssistantMessageEventStream(): AssistantMessageEventStream {
  return new AssistantMessageEventStream();
}
