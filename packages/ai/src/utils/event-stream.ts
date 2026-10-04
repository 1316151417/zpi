import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";
/** Single-consumer protocol stream. The final result is independent of iteration. */
export class AssistantMessageEventStream implements AsyncIterable<AssistantMessageEvent> {
  private queue: AssistantMessageEvent[] = [];
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
      const next = this.queue.shift();
      if (next) {
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
