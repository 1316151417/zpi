import { streamSimple as anthropic } from "./api/anthropic-messages.ts";
import { streamSimple as completions } from "./api/openai-completions.ts";
import { streamSimple as responses } from "./api/openai-responses.ts";
import type {
  AssistantMessageEvent,
  Model,
  SimpleStreamOptions,
  StreamFunction,
  TranscriptContext,
} from "./types.ts";
import { abortable } from "./utils/abort.ts";
import { createAssistantMessageEventStream } from "./utils/event-stream.ts";
import { guardModelStream } from "./utils/guard-model-stream.ts";
import { modelFailure } from "./utils/model-retry.ts";
import { emptyAssistant } from "./utils/transcript.ts";

/** Provider and wire-protocol selection stays inside zpi-ai. Credentials resolve for every request. */
export function streamSimple(
  model: Model,
  context: TranscriptContext,
  options: SimpleStreamOptions & { getApiKey?: (rejectedApiKey?: string) => Promise<string> } = {},
) {
  const { getApiKey, ...requestOptions } = options;
  return guardModelStream(
    model,
    (guarded) => streamRequest(model, context, { ...guarded, getApiKey }),
    requestOptions,
  );
}

function streamRequest(
  model: Model,
  context: TranscriptContext,
  options: SimpleStreamOptions & { getApiKey?: (rejectedApiKey?: string) => Promise<string> },
) {
  const { getApiKey, ...requestOptions } = options;
  if (model.api !== "openai-responses") {
    delete requestOptions.responsesSession;
    delete requestOptions.responsesWarmup;
  }
  const adapter: StreamFunction<Model["api"], SimpleStreamOptions> | undefined =
    model.api === "anthropic-messages"
      ? (anthropic as StreamFunction<Model["api"], SimpleStreamOptions>)
      : model.api === "openai-completions"
        ? completions
        : model.api === "openai-responses"
          ? responses
          : undefined;
  if (!adapter) throw new Error(`Unsupported API: ${model.api}`);
  if (!getApiKey) return adapter(model, context, requestOptions);
  const events = createAssistantMessageEventStream();
  void (async () => {
    options.signal?.throwIfAborted();
    let apiKey = await abortable(getApiKey(), options.signal);
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      let start: Extract<AssistantMessageEvent, { type: "start" }> | undefined;
      let progressed = false;
      let retry = false;
      for await (const event of adapter(model, context, { ...requestOptions, apiKey })) {
        if (event.type === "start") {
          start = event;
          continue;
        }
        if (
          event.type === "error" &&
          attempt === 0 &&
          !progressed &&
          event.error.content.length === 0 &&
          event.error.errorDetails?.status === 401 &&
          !options.signal?.aborted
        ) {
          const next = await abortable(getApiKey(apiKey), options.signal);
          options.signal?.throwIfAborted();
          if (next !== apiKey) {
            apiKey = next;
            retry = true;
            break;
          }
        }
        if (start) {
          events.push(start);
          start = undefined;
        }
        progressed = true;
        events.push(event);
      }
      if (!retry) return;
    }
  })().catch((error: unknown) => {
    const output = emptyAssistant(model);
    output.stopReason = options.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    output.errorDetails = modelFailure(error, options.signal);
    events.push({ type: "error", reason: output.stopReason, error: output });
  });
  return events;
}
