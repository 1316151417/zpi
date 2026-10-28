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
  DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS,
  ModelRecoveryDeadlineError,
  ModelRequestRetryError,
  readNextWithStreamIdleTimeout,
  resolveModelStreamIdleTimeoutMs,
} from "./stream-idle-timeout.ts";
import { emptyAssistant } from "./transcript.ts";

function hasModelProgress(event: AssistantMessageEvent): boolean {
  switch (event.type) {
    case "text_delta":
    case "thinking_delta":
    case "toolcall_delta":
      return event.delta.length > 0;
    case "text_end":
    case "thinking_end":
      return event.content.length > 0;
    case "toolcall_end":
      return event.toolCall.name.length > 0;
    case "text_start":
    case "thinking_start":
    case "toolcall_start": {
      const block = event.partial.content[event.contentIndex];
      return block?.type === "text"
        ? block.text.length > 0
        : block?.type === "thinking"
          ? block.thinking.length > 0
          : block?.type === "toolCall" && (block.name.length > 0 || Object.keys(block.arguments).length > 0);
    }
    default:
      return false;
  }
}

/** ZCode's iterator watchdog adapted to ZPI's model-event boundary, including custom providers. */
export function guardModelStream(
  model: Model,
  create: (
    options: SimpleStreamOptions,
  ) => AssistantMessageEventStream | Promise<AssistantMessageEventStream>,
  options: SimpleStreamOptions = {},
): AssistantMessageEventStream {
  const {
    streamIdleTimeoutMs,
    streamIdleTimeoutRetryNumber: _streamIdleTimeoutRetryNumber,
    streamFirstResponseTimeoutMs,
    streamDeadlineMs,
    retrySignal,
    onModelWait,
    ...requestOptions
  } = options;
  const timeoutMs = resolveModelStreamIdleTimeoutMs({
    baseTimeoutMs: streamIdleTimeoutMs,
  });
  const output = createAssistantMessageEventStream();
  const attempt = createLinkedAbortController(options.signal);
  const retry = () => attempt.controller.abort(new ModelRequestRetryError());
  if (retrySignal?.aborted) retry();
  else retrySignal?.addEventListener("abort", retry, { once: true });
  const firstTimeout = streamFirstResponseTimeoutMs ?? streamIdleTimeoutMs;
  const firstTimeoutMs =
    firstTimeout !== undefined && Number.isFinite(firstTimeout)
      ? firstTimeout
      : DEFAULT_MODEL_FIRST_RESPONSE_TIMEOUT_MS;
  let waiting = false;
  const reportWait = (status: Parameters<NonNullable<typeof onModelWait>>[0]) => {
    if (!status && !waiting) return;
    waiting = status !== null;
    try {
      onModelWait?.(status);
    } catch {
      /* Observers cannot control the request. */
    }
  };
  let partial = emptyAssistant(model);
  const closedCalls = new Set<string>();
  void (async () => {
    let iterator: AsyncIterator<AssistantMessageEvent> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    let waitTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      attempt.signal.throwIfAborted();
      if (streamDeadlineMs !== undefined && Number.isFinite(streamDeadlineMs)) {
        const remaining = streamDeadlineMs - Date.now();
        if (remaining <= 0) throw new ModelRecoveryDeadlineError();
        deadline = setTimeout(() => attempt.controller.abort(new ModelRecoveryDeadlineError()), remaining);
      }
      // The first next() includes asynchronous setup, so the same watchdog covers
      // credential lookup. Delegation also forwards return() to the actual provider.
      async function* events(): AsyncGenerator<AssistantMessageEvent> {
        yield* await create({ ...requestOptions, signal: attempt.signal });
      }
      iterator = events();
      let firstResponse = true;
      let lastEventAt = Date.now();
      const checkWait = () => {
        const remaining = 15_000 - (Date.now() - lastEventAt);
        if (remaining > 0) waitTimer = setTimeout(checkWait, remaining);
        else {
          waitTimer = undefined;
          reportWait({ phase: firstResponse ? "first_response" : "stream", startedAt: lastEventAt });
        }
      };
      if (onModelWait) waitTimer = setTimeout(checkWait, 15_000);
      while (true) {
        const windowMs = firstResponse ? firstTimeoutMs : timeoutMs;
        const next = await readNextWithStreamIdleTimeout(iterator, {
          abortController: attempt.controller,
          timeoutMs: windowMs,
          startedAt: lastEventAt,
        });
        attempt.signal.throwIfAborted();
        if (next.done) throw new Error("Stream ended without a terminal model event");
        const event = next.value;
        if (event.type === "done" || event.type === "error") {
          reportWait(null);
          output.push(event);
          void closeStreamIterator(iterator);
          return;
        }
        partial = event.partial;
        if (event.type === "toolcall_end") closedCalls.add(event.toolCall.id);
        // Providers also emit empty content-block starts and deltas while waiting for actual output.
        if (hasModelProgress(event)) {
          firstResponse = false;
          lastEventAt = Date.now();
          if (waiting) {
            reportWait(null);
            if (onModelWait) waitTimer = setTimeout(checkWait, 15_000);
          }
        }
        output.push(event);
      }
    } catch (error) {
      clearTimeout(waitTimer);
      reportWait(null);
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
      clearTimeout(deadline);
      clearTimeout(waitTimer);
      reportWait(null);
      retrySignal?.removeEventListener("abort", retry);
      attempt.cleanup();
    }
  })();
  return output;
}
