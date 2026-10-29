import OpenAI from "openai";
import type {
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import type {
  ImageContent,
  Model,
  SimpleStreamOptions,
  StreamOptions,
  ToolCall,
  TranscriptContext,
} from "../types.ts";
import { openAICompletionsCompatKeys } from "../types.ts";
import { measureContextBreakdown } from "../utils/context-breakdown.ts";
import { calculateCost } from "../utils/cost.ts";
import { formatProviderError, normalizeProviderError } from "../utils/error-body.ts";
import { projectContextForModelMediaPolicy } from "../utils/media-policy.ts";
import { MeasuredAssistantStream } from "../utils/model-performance.ts";
import { modelFailure } from "../utils/model-retry.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { reasoningParameterKeys, reasoningParameters } from "../utils/reasoning.ts";
import { redactProviderError } from "../utils/redact-error.ts";
import {
  assertSupportedOptions,
  contentText,
  emptyAssistant,
  getCurrentSystemPrompt,
  getCurrentTools,
  isJsonObject,
} from "../utils/transcript.ts";
import { transformMessages } from "./transform-messages.ts";
export interface OpenAICompletionsOptions extends StreamOptions {
  reasoningEffort?: string;
  reasoning?: SimpleStreamOptions["reasoning"];
  toolChoice?: ChatCompletionCreateParamsStreaming["tool_choice"];
}
const commonOptions = [
  "signal",
  "sessionId",
  "cacheRetention",
  "skipCacheWrite",
  "apiKey",
  "fetch",
  "headers",
  "temperature",
  "maxTokens",
  "timeoutMs",
  "maxRetries",
  "maxRetryDelayMs",
  "onRetry",
  "onPayload",
  "onResponse",
  "onPerformance",
  "onMediaProjection",
  "samplingParams",
];
function imagePart(c: ImageContent): { type: "image_url"; image_url: { url: string } } {
  return { type: "image_url", image_url: { url: `data:${c.mimeType};base64,${c.data}` } };
}
function serialize(context: TranscriptContext, model: Model): ChatCompletionMessageParam[] {
  const messages: ChatCompletionMessageParam[] = [];
  const toolImages: ChatCompletionMessageParam[] = [];
  const flushToolImages = () => {
    messages.push(...toolImages);
    toolImages.length = 0;
  };
  const prompt = getCurrentSystemPrompt(context.messages);
  if (prompt)
    messages.push({ role: model.compat?.supportsDeveloperRole ? "developer" : "system", content: prompt });
  for (const m of transformMessages(context.messages, model)) {
    if (m.role === "system") continue;
    if (m.role !== "toolResult") flushToolImages();
    if (m.role === "user") {
      messages.push({
        role: "user",
        content:
          typeof m.content === "string"
            ? m.content
            : m.content.map((c) => (c.type === "image" ? imagePart(c) : { type: "text", text: c.text })),
      });
    } else if (m.role === "assistant") {
      const sameModel = m.provider === model.provider && m.api === model.api && m.model === model.id;
      const calls = m.content.filter((c) => c.type === "toolCall");
      const content = m.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .filter((text) => text.trim())
        .join("\n");
      // Reasoning fields alone do not satisfy Chat Completions' assistant message contract.
      if (!content && !calls.length) continue;
      const out: ChatCompletionMessageParam & { reasoning_content?: string } = {
        role: "assistant",
        content: content || null,
        ...(calls.length
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.arguments) },
              })),
            }
          : {}),
      };
      if (model.compat?.requiresReasoningContentOnAssistantMessages && model.reasoning)
        out.reasoning_content = (sameModel ? m.content : [])
          .filter((c) => c.type === "thinking")
          .filter((c) => !c.redacted && c.thinking.trim())
          .map((c) => c.thinking)
          .join("\n");
      messages.push(out);
    } else {
      messages.push({
        role: "tool",
        tool_call_id: m.toolCallId,
        content: contentText(m.content) || "Image result attached.",
      });
      // Keep every tool result adjacent to its assistant batch before sending visual input.
      const images = m.content.filter((c) => c.type === "image");
      if (images.length && model.input.includes("image"))
        toolImages.push({
          role: "user",
          content: [{ type: "text", text: `Images from tool ${m.toolCallId}:` }, ...images.map(imagePart)],
        });
    }
  }
  flushToolImages();
  return messages;
}
export function streamSimple(model: Model, context: TranscriptContext, options: SimpleStreamOptions = {}) {
  assertSupportedOptions(options, [...commonOptions, "reasoning", "toolChoice"], "streamSimple");
  if (options.apiKey === undefined)
    throw new Error(
      "API key must be configured; use an explicit empty string for an unauthenticated service",
    );
  if (options.toolChoice !== undefined && options.toolChoice !== "auto" && options.toolChoice !== "none")
    throw new Error("Unsupported toolChoice");
  return stream(model, context, options);
}
export function stream(model: Model, context: TranscriptContext, options: OpenAICompletionsOptions = {}) {
  assertSupportedOptions(options, [...commonOptions, "reasoning", "reasoningEffort", "toolChoice"], "stream");
  if (model.api !== "openai-completions") throw new Error(`Unsupported API: ${model.api}`);
  assertSupportedOptions(model.compat ?? {}, openAICompletionsCompatKeys, "compat");
  const events = new MeasuredAssistantStream(options);
  let output = emptyAssistant(model);
  const completeCalls = new Set<ToolCall>();
  void consume(events).catch((error: unknown) => {
    output.content = output.content.filter((block) => block.type !== "toolCall" || completeCalls.has(block));
    output.stopReason = options.signal?.aborted ? "aborted" : "error";
    let message = formatProviderError(normalizeProviderError(error));
    const body = error !== null && typeof error === "object" && "error" in error ? error.error : undefined;
    const metadata = isJsonObject(body) && isJsonObject(body.metadata) ? body.metadata.raw : undefined;
    if (metadata && !message.includes(String(metadata))) message += `\n${metadata}`;
    output.errorMessage = redactProviderError(message, [
      options.apiKey,
      ...Object.values(model.headers ?? {}),
      ...Object.values(options.headers ?? {}),
    ]);
    output.errorDetails = modelFailure(error, options.signal);
    events.push({ type: "error", reason: output.stopReason, error: output });
  });
  return events;
  async function consume(events: MeasuredAssistantStream): Promise<void> {
    output = emptyAssistant(model);
    completeCalls.clear();
    context = projectContextForModelMediaPolicy(context, model, { onProjection: options.onMediaProjection });
    const client = new OpenAI({
      // OpenAI's constructor requires a nonempty value; the explicit no-auth path removes its header.
      apiKey: options.apiKey || "ZPI-no-auth",
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: model.baseUrl,
      maxRetries: 0,
      timeout: options.timeoutMs,
      fetch: options.fetch,
      defaultHeaders: {
        ...model.headers,
        ...options.headers,
        ...(options.apiKey === "" ? { Authorization: null } : {}),
      },
    });
    const tools = getCurrentTools(context.messages);
    const hostname = new URL(model.baseUrl).hostname;
    const maxTokensField =
      model.compat?.maxTokensField ??
      (hostname === "api.openai.com" || hostname.endsWith(".api.openai.com")
        ? "max_completion_tokens"
        : "max_tokens");
    let payload: unknown = {
      model: model.id,
      messages: serialize(context, model),
      stream: true,
      ...(model.compat?.supportsUsageInStreaming !== false
        ? { stream_options: { include_usage: true } }
        : {}),
      [maxTokensField]: options.maxTokens ?? model.maxTokens,
      ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
      ...(tools.length
        ? {
            tools: tools.map((t) => ({
              type: "function",
              function: { name: t.name, description: t.description, parameters: t.parameters },
            })),
          }
        : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...model.samplingParams,
      ...options.samplingParams,
    };
    const thinking = reasoningParameters(model, options.reasoning);
    if (isJsonObject(payload) && (thinking !== undefined || !model.reasoning)) {
      for (const key of reasoningParameterKeys) delete payload[key];
      Object.assign(payload, thinking ?? {});
    }
    if (
      isJsonObject(payload) &&
      model.reasoning &&
      options.reasoningEffort &&
      model.compat?.supportsReasoningEffort
    )
      payload.reasoning_effort = options.reasoningEffort;
    const replacement = await options.onPayload?.(payload, model);
    if (replacement !== undefined) payload = replacement;
    if (!isJsonObject(payload) || payload.stream !== true)
      throw new Error("Payload must be a streaming request object");
    output.contextBreakdown = measureContextBreakdown(payload);
    const { data: chunks, response } = await retryProviderRequest(
      () => {
        events.startRequest();
        return client.chat.completions
          .create(payload as unknown as ChatCompletionCreateParamsStreaming, { signal: options.signal })
          .withResponse();
      },
      { ...options, maxRetries: options.maxRetries ?? 2 },
    );
    await options.onResponse?.(
      { status: response.status, headers: Object.fromEntries(response.headers) },
      model,
    );
    events.push({ type: "start", partial: output });
    const toolStates = new Map<number, { call: ToolCall; index: number; raw: string }>();
    let current: { type: "text" | "thinking"; index: number } | undefined;
    let finish: string | undefined;
    function closeCurrent(): void {
      if (!current) return;
      const block = output.content[current.index];
      if (block?.type === "text")
        events.push({ type: "text_end", contentIndex: current.index, content: block.text, partial: output });
      if (block?.type === "thinking")
        events.push({
          type: "thinking_end",
          contentIndex: current.index,
          content: block.thinking,
          partial: output,
        });
      current = undefined;
    }
    function append(type: "text" | "thinking", delta: string): void {
      if (!delta) return;
      if (current?.type !== type) {
        closeCurrent();
        const index = output.content.length;
        output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
        current = { type, index };
        events.push({
          type: type === "text" ? "text_start" : "thinking_start",
          contentIndex: index,
          partial: output,
        });
      }
      const index = current.index;
      const block = output.content[index];
      if (block?.type === "text") block.text += delta;
      if (block?.type === "thinking") block.thinking += delta;
      events.push({
        type: type === "text" ? "text_delta" : "thinking_delta",
        contentIndex: index,
        delta,
        partial: output,
      });
    }
    for await (const chunk of chunks) {
      events.received();
      if (options.signal?.aborted) throw new Error("Request aborted");
      output.responseId = chunk.id;
      output.responseModel = chunk.model;
      if (chunk.usage) {
        const u = chunk.usage;
        const cached = u.prompt_tokens_details?.cached_tokens ?? 0;
        const reasoning = u.completion_tokens_details?.reasoning_tokens;
        const validCount = (value: unknown): value is number =>
          typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
        output.usageAvailable =
          validCount(u.prompt_tokens) &&
          validCount(u.completion_tokens) &&
          validCount(u.total_tokens) &&
          validCount(cached) &&
          cached <= u.prompt_tokens &&
          (reasoning == null || validCount(reasoning));
        output.cacheUsageAvailable = output.usageAvailable && u.prompt_tokens_details?.cached_tokens != null;
        if (output.usageAvailable) {
          output.usage.input = u.prompt_tokens - cached;
          output.usage.cacheRead = cached;
          output.usage.output = u.completion_tokens;
          output.usage.reasoning = reasoning;
          output.usage.totalTokens = u.total_tokens;
        }
      }
      const choice = chunk.choices[0];
      if (!choice) {
        if (chunk.usage) events.recordUsage(chunk.usage.completion_tokens);
        continue;
      }
      if (choice.finish_reason) finish = choice.finish_reason;
      const d = choice.delta as typeof choice.delta & {
        reasoning_content?: unknown;
        reasoning?: unknown;
        reasoning_text?: unknown;
      };
      const thinking = [d.reasoning_content, d.reasoning, d.reasoning_text].find(
        (v) => typeof v === "string",
      );
      if (typeof thinking === "string") append("thinking", thinking);
      if (d.content) append("text", d.content);
      for (const t of d.tool_calls ?? []) {
        closeCurrent();
        let state = toolStates.get(t.index);
        if (!state) {
          const call: ToolCall = { type: "toolCall", id: "", name: "", arguments: {} };
          state = { call, index: output.content.length, raw: "" };
          toolStates.set(t.index, state);
          output.content.push(call);
          events.push({ type: "toolcall_start", contentIndex: state.index, partial: output });
        }
        if (t.id) state.call.id += t.id;
        if (t.function?.name) {
          state.call.name += t.function.name;
          events.generated();
        }
        if (t.function?.arguments) {
          state.raw += t.function.arguments;
          events.push({
            type: "toolcall_delta",
            contentIndex: state.index,
            delta: t.function.arguments,
            partial: output,
          });
        }
      }
      if (chunk.usage) events.recordUsage(chunk.usage.completion_tokens);
    }
    closeCurrent();
    if (options.signal?.aborted) throw new Error("Request aborted");
    if (!finish) throw new Error("Stream ended without finish_reason");
    output.rawStopReason = finish;
    for (const state of toolStates.values()) {
      try {
        const args: unknown = JSON.parse(state.raw || "{}");
        if (!state.call.id || !state.call.name || !isJsonObject(args))
          throw new Error("Incomplete tool call");
        state.call.arguments = args;
      } catch (error) {
        // A token cutoff can end inside JSON; keep its length/usage facts without executing the fragment.
        if (finish === "length") continue;
        throw error;
      }
      completeCalls.add(state.call);
      events.push({ type: "toolcall_end", contentIndex: state.index, toolCall: state.call, partial: output });
    }
    output.content = output.content.filter((block) => block.type !== "toolCall" || completeCalls.has(block));
    if (finish === "content_filter") throw new Error("Response blocked by provider");
    if (!["stop", "length", "tool_calls", "function_call"].includes(finish))
      throw new Error(`Unsupported finish_reason: ${finish}`);
    output.stopReason = finish === "length" ? "length" : toolStates.size ? "toolUse" : "stop";
    calculateCost(model, output.usage);
    events.push({ type: "done", reason: output.stopReason, message: output });
  }
}
