import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  Model,
  SimpleStreamOptions,
} from "../types.ts";
import { createAssistantMessageEventStream } from "./event-stream.ts";
import { modelFailure } from "./model-retry.ts";
import {
  closeStreamIterator,
  createLinkedAbortController,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.ts";
import { emptyAssistant } from "./transcript.ts";

/** ZCode's iterator watchdog adapted to ZPI's model-event boundary, including custom providers. */
export function guardModelStream(
  model: Model,
  create: (
    options: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const { streamIdleTimeoutMs, streamIdleTimeoutRetryNumber, ...requestOptions } = options;
  const timeoutMs = resolveModelStreamIdleTimeoutMs({
    baseTimeoutMs: streamIdleTimeoutMs,
    retryNumber: streamIdleTimeoutRetryNumber,
  });
  const output = createAssistantMessageEventStream();
  const attempt = createLinkedAbortController(options.signal);
  let partial = emptyAssistant(model);
  const closedCalls = new Set<string>();
  void (async () => {
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    try {
      attempt.signal.throwIfAborted();
      // The first next() includes asynchronous setup, so the same watchdog covers
      // credential lookup. Delegation also forwards return() to the actual provider.
      async function* events(): AsyncGenerator<AssistantMessageEvent> {
        yield* await create({ ...requestOptions, signal: attempt.signal });
      }
      iterator = events();
      while (true) {
        const next = await readNextWithStreamIdleTimeout(iterator, {
          abortController: attempt.controller,
          timeoutMs,
        });
        if (next.done) throw new Error("Stream ended without a terminal model event");
        const event = next.value;
        if (event.type === "done" || event.type === "error") {
          output.push(event);
          void closeStreamIterator(iterator);
          return;
        }
        partial = event.partial;
        if (event.type === "toolcall_end") closedCalls.add(event.toolCall.id);
        output.push(event);
      }
    } catch (error) {
      // Never mutate a provider-owned partial: an abort-ignoring producer may still finish later.
      const failure = structuredClone(partial);
      failure.content = failure.content.filter(
        (block) => block.type !== "toolCall" || closedCalls.has(block.id),
      );
      failure.stopReason = options.signal?.aborted ? "aborted" : "error";
      failure.errorMessage = error instanceof Error ? error.message : String(error);
      // Classify against the caller signal, not our locally aborted watchdog signal.
      failure.errorDetails = modelFailure(error, options.signal);
      if (!attempt.signal.aborted) attempt.controller.abort(error);
      await closeStreamIterator(iterator);
      output.end(failure);
    } finally {
      attempt.cleanup();
    }
  })();
  return output;
}
