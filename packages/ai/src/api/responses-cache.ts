import type { ResponseCreateParamsStreaming, ResponseInput } from "openai/resources/responses/responses";
import type { Model, StreamOptions } from "../types.ts";

/** OpenAI's cache controls differ before and after GPT-5.6; unknown gateway aliases keep their defaults. */
export function responsesCache(
  model: Model,
  options: StreamOptions,
  input: ResponseInput,
): { input: ResponseInput } & Pick<
  ResponseCreateParamsStreaming,
  "prompt_cache_key" | "prompt_cache_options" | "prompt_cache_retention"
> {
  const key =
    options.sessionId && options.cacheRetention !== "none"
      ? { prompt_cache_key: options.sessionId.slice(0, 64) }
      : {};
  const version = /^gpt-(\d+)(?:\.(\d+))?(?:-|$)/.exec(model.id);
  const explicit =
    version && (Number(version[1]) > 5 || (Number(version[1]) === 5 && Number(version[2]) >= 6));
  if (explicit) {
    const mode = options.cacheRetention === "none" || options.skipCacheWrite ? "explicit" : "implicit";
    return {
      ...key,
      input: options.skipCacheWrite && options.cacheRetention !== "none" ? markStablePrefix(input) : input,
      ...(options.cacheRetention || options.skipCacheWrite
        ? { prompt_cache_options: { mode, ttl: "30m" } }
        : {}),
    };
  }
  const legacyExtended =
    /^gpt-(?:5(?:-codex)?|5\.1(?:-codex(?:-max|-mini)?|-chat-latest)?|5\.2|5\.4|5\.5(?:-pro)?|4\.1)(?:-\d{4}-\d{2}-\d{2})?$/.test(
      model.id,
    );
  const retention =
    options.cacheRetention === "long"
      ? "24h"
      : options.cacheRetention === "short" && !/^gpt-5\.5(?:-|$)/.test(model.id)
        ? "in_memory"
        : undefined;
  return {
    ...key,
    input,
    ...(legacyExtended && model.auth !== "chatgpt" && retention ? { prompt_cache_retention: retention } : {}),
  };
}

function markStablePrefix(input: ResponseInput): ResponseInput {
  // Exclude the transient final prompt; never insert markers inside tool arguments or reasoning items.
  for (let index = input.length - 2; index >= 0; index--) {
    const item = input[index];
    const marker = { mode: "explicit" as const };
    if ("content" in item && "role" in item && typeof item.content === "string") {
      const copy = input.slice();
      copy[index] = {
        ...item,
        content: [{ type: "input_text", text: item.content, prompt_cache_breakpoint: marker }],
      };
      return copy;
    }
    if (item.type === "function_call_output" && typeof item.output === "string") {
      const copy = input.slice();
      copy[index] = {
        ...item,
        output: [{ type: "input_text" as const, text: item.output, prompt_cache_breakpoint: marker }],
      };
      return copy;
    }
    if ("content" in item && Array.isArray(item.content)) {
      const blockIndex = item.content.findLastIndex(
        (block) => block.type === "input_text" || block.type === "input_image" || block.type === "input_file",
      );
      if (blockIndex < 0) continue;
      const copy = input.slice();
      copy[index] = {
        ...item,
        content: item.content.map((block, part) =>
          part === blockIndex ? { ...block, prompt_cache_breakpoint: marker } : block,
        ),
      } as ResponseInput[number];
      return copy;
    }
  }
  return input;
}
