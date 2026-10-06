import { streamSimple as completions } from "./api/openai-completions.ts";
import { streamSimple as responses } from "./api/openai-responses.ts";
import type { Model, SimpleStreamOptions, TranscriptContext } from "./types.ts";
import { createAssistantMessageEventStream } from "./utils/event-stream.ts";
import { emptyAssistant } from "./utils/transcript.ts";

/** Provider and wire-protocol selection stays inside ZPI-ai. Credentials resolve for every request. */
export function streamSimple(
  model: Model,
  context: TranscriptContext,
  options: SimpleStreamOptions & { getApiKey?: () => Promise<string> } = {},
) {
  const { getApiKey, ...requestOptions } = options;
  const adapter =
    model.api === "openai-completions"
      ? completions
      : model.api === "openai-responses"
        ? responses
        : undefined;
  if (!adapter) throw new Error(`Unsupported API: ${model.api}`);
  if (!getApiKey) return adapter(model, context, requestOptions);
  const events = createAssistantMessageEventStream();
  void (async () => {
    if (options.signal?.aborted) throw new Error("Request aborted");
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new Error("Request aborted"));
      options.signal?.addEventListener("abort", onAbort, { once: true });
    });
    let apiKey: string;
    try {
      apiKey = await Promise.race([getApiKey(), abort]);
    } finally {
      if (onAbort) options.signal?.removeEventListener("abort", onAbort);
    }
    if (options.signal?.aborted) throw new Error("Request aborted");
    for await (const event of adapter(model, context, { ...requestOptions, apiKey })) events.push(event);
  })().catch((error: unknown) => {
    const output = emptyAssistant(model);
    output.stopReason = options.signal?.aborted ? "aborted" : "error";
    output.errorMessage = error instanceof Error ? error.message : String(error);
    events.push({ type: "error", reason: output.stopReason, error: output });
  });
  return events;
}
