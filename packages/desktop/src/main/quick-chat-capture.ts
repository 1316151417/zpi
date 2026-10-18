import type { QuickChatDraftInput } from "../shared/quick-chat.ts";

export type QuickChatCaptureKind = "screenshot" | "selection" | "clipboard";
interface Options {
  sessionId(): string;
  hide(): void;
  read(
    kind: QuickChatCaptureKind,
    signal: AbortSignal,
  ): QuickChatDraftInput | undefined | Promise<QuickChatDraftInput | undefined>;
  open(input: QuickChatDraftInput, sessionId: string): Promise<void>;
}

/** Capture before taking focus. One active capture; repeats join without duplicating its contents. */
export class QuickChatCapture {
  private pending?: { abort: AbortController; promise: Promise<void> };
  private disposed = false;
  private readonly options: Options;
  constructor(options: Options) {
    this.options = options;
  }
  invoke(kind: QuickChatCaptureKind): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.pending) return this.pending.promise.catch(() => {});
    const abort = new AbortController();
    const sessionId = this.options.sessionId();
    const deliver = (input: QuickChatDraftInput | undefined) => {
      if (!input || abort.signal.aborted || sessionId !== this.options.sessionId()) return;
      return this.options.open(input, sessionId);
    };
    const completion = Promise.withResolvers<void>();
    const pending = {
      abort,
      promise: completion.promise.finally(() => {
        if (this.pending === pending) this.pending = undefined;
      }),
    };
    this.pending = pending;
    try {
      if (kind === "screenshot") this.options.hide();
      const input = this.options.read(kind, abort.signal);
      // Clipboard reads and the warm open start in the native callback stack.
      const opening = input instanceof Promise ? input.then(deliver) : deliver(input);
      void Promise.resolve(opening).then(completion.resolve, completion.reject);
    } catch (error) {
      completion.reject(error);
    }
    return pending.promise;
  }
  dispose(): void {
    this.disposed = true;
    this.pending?.abort.abort();
  }
}
