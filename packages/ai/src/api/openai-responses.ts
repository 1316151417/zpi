import OpenAI from "openai";
import type {
  ResponseCreateParamsStreaming,
  ResponseInput,
  ResponseOutputItem,
} from "openai/resources/responses/responses";
import type { Model, SimpleStreamOptions, ThinkingContent, ToolCall, TranscriptContext } from "../types.ts";
import { measureContextBreakdown } from "../utils/context-breakdown.ts";
import { createAssistantMessageEventStream } from "../utils/event-stream.ts";
import { retryProviderRequest } from "../utils/provider-retry.ts";
import { reasoningParameters } from "../utils/reasoning.ts";
import {
  assertSupportedOptions,
  emptyAssistant,
  getCurrentSystemPrompt,
  getCurrentTools,
  isJsonObject,
} from "../utils/transcript.ts";
import { transformMessages } from "./transform-messages.ts";

export function responsesInput(model: Model, context: TranscriptContext): ResponseInput {
  const input: ResponseInput = [];
  for (const message of transformMessages(context.messages, model)) {
    if (message.role === "system") continue;
    if (message.role === "user") {
      input.push({
        role: "user",
        content:
          typeof message.content === "string"
            ? message.content
            : message.content.map((block) =>
                block.type === "text"
                  ? { type: "input_text", text: block.text }
                  : {
                      type: "input_image",
                      image_url: `data:${block.mimeType};base64,${block.data}`,
                      detail: "auto",
                    },
              ),
      });
    } else if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text" && block.text.trim()) {
          input.push({ role: "assistant", content: block.text });
        } else if (block.type === "thinking" && block.thinkingSignature) {
          const item: unknown = JSON.parse(block.thinkingSignature);
          if (isJsonObject(item) && item.type === "reasoning")
            input.push(item as unknown as ResponseInput[number]);
        } else if (block.type === "toolCall") {
          const [callId, itemId] = block.id.split("|");
          input.push({
            type: "function_call",
            call_id: callId,
            ...(itemId ? { id: itemId } : {}),
            name: block.name,
            arguments: JSON.stringify(block.arguments),
            ...(model.auth === "chatgpt"
              ? { namespace: "zpi" }
              : block.namespace
                ? { namespace: block.namespace }
                : {}),
          });
        }
      }
    } else {
      const text = message.content
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n");
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId.split("|")[0],
        output: text || "Image result attached.",
      });
      const images = message.content.filter((c) => c.type === "image");
      if (images.length && model.input.includes("image"))
        input.push({
          role: "user",
          content: [
            { type: "input_text", text: `Images from tool ${message.toolName}:` },
            ...images.map((c) => ({
              type: "input_image" as const,
              image_url: `data:${c.mimeType};base64,${c.data}`,
              detail: "auto" as const,
            })),
          ],
        });
    }
  }
  return input;
}

export function streamSimple(model: Model, context: TranscriptContext, options: SimpleStreamOptions = {}) {
  assertSupportedOptions(
    options,
    [
      "signal",
      "sessionId",
      "apiKey",
      "fetch",
      "headers",
      "temperature",
      "maxTokens",
      "timeoutMs",
      "maxRetries",
      "maxRetryDelayMs",
      "onPayload",
      "onResponse",
      "samplingParams",
      "reasoning",
      "toolChoice",
    ],
    "streamSimple",
  );
  if (model.api !== "openai-responses") throw new Error(`Unsupported API: ${model.api}`);
  if (options.apiKey === undefined) throw new Error("API key must be configured");
  const events = createAssistantMessageEventStream();
  const output = emptyAssistant(model);
  const complete = new Set<ToolCall>();
  void consume().catch((error: unknown) => {
    output.content = output.content.filter((block) => block.type !== "toolCall" || complete.has(block));
    output.stopReason = options.signal?.aborted ? "aborted" : "error";
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of [
      options.apiKey,
      ...Object.values(model.headers ?? {}),
      ...Object.values(options.headers ?? {}),
    ])
      if (secret) message = message.split(secret).join("[redacted]");
    output.errorMessage = message;
    events.push({ type: "error", reason: output.stopReason, error: output });
  });
  return events;
  async function consume() {
    if (
      !model.input.includes("image") &&
      context.messages.some(
        (m) => m.role === "user" && Array.isArray(m.content) && m.content.some((c) => c.type === "image"),
      )
    )
      throw new Error("Model does not support images in the effective context");
    const client = new OpenAI({
      apiKey: options.apiKey || "zpi-no-auth",
      adminAPIKey: null,
      organization: null,
      project: null,
      baseURL: model.baseUrl,
      maxRetries: 0,
      timeout: options.timeoutMs,
      fetch: options.fetch,
      defaultHeaders: {
        ...(options.sessionId
          ? { session_id: options.sessionId, "x-client-request-id": options.sessionId }
          : {}),
        ...model.headers,
        ...options.headers,
        ...(options.apiKey === "" ? { Authorization: null } : {}),
      },
    });
    const tools = getCurrentTools(context.messages).map((t) => ({
      type: "function" as const,
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      strict: false,
    }));
    const thinking = reasoningParameters(model, options.reasoning);
    const effort = thinking?.reasoning_effort;
    const reasoning = isJsonObject(thinking?.reasoning)
      ? { summary: "auto", ...thinking.reasoning }
      : typeof effort === "string"
        ? { effort, summary: "auto" }
        : undefined;
    let payload: unknown = {
      model: model.id,
      input: responsesInput(model, context),
      instructions: getCurrentSystemPrompt(context.messages),
      store: false,
      stream: true,
      ...(options.sessionId ? { prompt_cache_key: options.sessionId.slice(0, 64) } : {}),
      include: ["reasoning.encrypted_content"],
      ...(tools.length
        ? {
            tools:
              model.auth === "chatgpt"
                ? [{ type: "namespace", name: "zpi", description: "Local coding tools", tools }]
                : tools,
          }
        : {}),
      ...(options.toolChoice ? { tool_choice: options.toolChoice } : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(model.auth !== "chatgpt"
        ? {
            max_output_tokens: options.maxTokens ?? model.maxTokens,
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
          }
        : {}),
      ...model.samplingParams,
      ...options.samplingParams,
    };
    const replacement = await options.onPayload?.(payload, model);
    if (replacement !== undefined) payload = replacement;
    if (!isJsonObject(payload) || payload.stream !== true || !Array.isArray(payload.input))
      throw new Error("Payload must be a streaming Responses request object");
    if (isJsonObject(payload.reasoning) && payload.reasoning.summary === undefined)
      payload.reasoning.summary = "auto";
    // Keep callers' structured-output preferences portable across both transports.
    const format = payload.response_format;
    if (isJsonObject(format)) {
      const schema = format.json_schema;
      payload.text = {
        ...(isJsonObject(payload.text) ? payload.text : {}),
        format:
          format.type === "json_schema" && isJsonObject(schema) ? { type: "json_schema", ...schema } : format,
      };
      delete payload.response_format;
    }
    if (isJsonObject(payload.reasoning) && typeof payload.reasoning.effort === "string")
      output.providerThinkingLevel = payload.reasoning.effort;
    if (model.auth === "chatgpt") {
      for (const key of [
        "background",
        "conversation",
        "max_output_tokens",
        "max_tool_calls",
        "metadata",
        "moderation",
        "multi_agent",
        "prompt",
        "prompt_cache_retention",
        "safety_identifier",
        "temperature",
        "top_logprobs",
        "top_p",
        "truncation",
        "user",
        "previous_response_id",
      ])
        delete payload[key];
      payload.store = false;
    }
    output.contextBreakdown = measureContextBreakdown(payload);
    const { data: chunks, response } = await retryProviderRequest(
      () =>
        client.responses
          .create(payload as unknown as ResponseCreateParamsStreaming, { signal: options.signal })
          .withResponse(),
      {
        maxRetries: options.maxRetries ?? 2,
        maxRetryDelayMs: options.maxRetryDelayMs,
        signal: options.signal,
      },
    );
    await options.onResponse?.(
      { status: response.status, headers: Object.fromEntries(response.headers) },
      model,
    );
    events.push({ type: "start", partial: output });
    const blocks = new Map<string, number>();
    const args = new Map<string, string>();
    const ended = new Set<string>();
    const contentKey = (itemId: string, index: number) => `${itemId}:${index}`;
    function append(key: string, type: "text" | "thinking", delta: string) {
      let index = blocks.get(key);
      if (index === undefined) {
        index = output.content.length;
        blocks.set(key, index);
        output.content.push(type === "text" ? { type, text: "" } : { type, thinking: "" });
        events.push({
          type: type === "text" ? "text_start" : "thinking_start",
          contentIndex: index,
          partial: output,
        });
      }
      const block = output.content[index];
      if (block.type === "text") block.text += delta;
      if (block.type === "thinking") block.thinking += delta;
      if (delta)
        events.push({
          type: type === "text" ? "text_delta" : "thinking_delta",
          contentIndex: index,
          delta,
          partial: output,
        });
    }
    function close(key: string) {
      if (ended.has(key)) return;
      const index = blocks.get(key);
      if (index === undefined) return;
      const block = output.content[index];
      if (block.type === "text")
        events.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
      if (block.type === "thinking")
        events.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
      ended.add(key);
    }
    function completeThinking(key: string, text: string) {
      const index = blocks.get(key);
      const block = index === undefined ? undefined : output.content[index];
      const current = block?.type === "thinking" ? block.thinking : "";
      if (text.startsWith(current)) append(key, "thinking", text.slice(current.length));
      else if (block?.type === "thinking") block.thinking = text;
      close(key);
    }
    function itemAdded(item: ResponseOutputItem) {
      if (item.type === "reasoning") {
        if (!blocks.has(contentKey(item.id, 0))) append(contentKey(item.id, 0), "thinking", "");
        return;
      }
      if (item.type !== "function_call") return;
      if (!item.id) throw new Error("Incomplete tool call item ID");
      if (blocks.has(item.id)) return;
      const call: ToolCall = {
        type: "toolCall",
        id: `${item.call_id}|${item.id}`,
        name: item.name,
        arguments: {},
        ...(item.namespace ? { namespace: item.namespace } : {}),
      };
      blocks.set(item.id, output.content.length);
      args.set(item.id, item.arguments ?? "");
      output.content.push(call);
      events.push({ type: "toolcall_start", contentIndex: output.content.length - 1, partial: output });
    }
    function itemDone(item: ResponseOutputItem) {
      if (item.type === "function_call") {
        if (!item.id) throw new Error("Incomplete tool call item ID");
        itemAdded(item);
        if (ended.has(item.id)) return;
        const index = blocks.get(item.id);
        if (index === undefined) throw new Error("Incomplete tool call");
        const block = output.content[index];
        const argumentsValue: unknown = JSON.parse(item.arguments || args.get(item.id) || "{}");
        if (block.type !== "toolCall" || !item.call_id || !item.name || !isJsonObject(argumentsValue))
          throw new Error("Incomplete tool call");
        block.arguments = argumentsValue;
        complete.add(block);
        ended.add(item.id);
        events.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
      } else if (item.type === "reasoning") {
        itemAdded(item);
        const parts = item.summary.length ? item.summary : (item.content ?? []);
        for (const [index, part] of parts.entries()) completeThinking(contentKey(item.id, index), part.text);
        const first = blocks.get(contentKey(item.id, 0));
        if (first !== undefined)
          (output.content[first] as ThinkingContent).thinkingSignature = JSON.stringify(item);
        for (const key of [...blocks.keys()].filter((key) => key.startsWith(`${item.id}:`))) close(key);
      } else if (item.type === "message") {
        item.content.forEach((part, index) => {
          const key = contentKey(item.id, index);
          const text = part.type === "output_text" ? part.text : part.refusal;
          if (!blocks.has(key)) append(key, "text", text);
          const blockIndex = blocks.get(key);
          if (blockIndex !== undefined && output.content[blockIndex].type === "text")
            output.content[blockIndex].textSignature = item.id;
          close(key);
        });
      }
    }
    let terminal = false;
    for await (const event of chunks) {
      if (options.signal?.aborted) throw new Error("Request aborted");
      switch (event.type) {
        case "response.created":
          output.responseId = event.response.id;
          output.responseModel = event.response.model;
          break;
        case "response.output_item.added":
          itemAdded(event.item);
          break;
        case "response.output_text.delta":
        case "response.refusal.delta":
          append(contentKey(event.item_id, event.content_index), "text", event.delta);
          break;
        case "response.reasoning_summary_text.delta":
          append(contentKey(event.item_id, event.summary_index), "thinking", event.delta);
          break;
        case "response.reasoning_summary_text.done":
          completeThinking(contentKey(event.item_id, event.summary_index), event.text);
          break;
        case "response.reasoning_summary_part.done":
          completeThinking(contentKey(event.item_id, event.summary_index), event.part.text);
          break;
        case "response.reasoning_text.delta":
          append(contentKey(event.item_id, event.content_index), "thinking", event.delta);
          break;
        case "response.reasoning_text.done":
          completeThinking(contentKey(event.item_id, event.content_index), event.text);
          break;
        case "response.function_call_arguments.delta": {
          args.set(event.item_id, (args.get(event.item_id) ?? "") + event.delta);
          const index = blocks.get(event.item_id);
          if (index !== undefined)
            events.push({ type: "toolcall_delta", contentIndex: index, delta: event.delta, partial: output });
          break;
        }
        case "response.output_item.done":
          itemDone(event.item);
          break;
        case "error":
          throw new Error(`OpenAI Responses: ${event.code ?? "error"}: ${event.message}`);
        case "response.failed":
          throw new Error(
            `OpenAI Responses: ${event.response.error?.code ?? "failed"}: ${event.response.error?.message ?? "Request failed"}`,
          );
        case "response.incomplete":
        case "response.completed": {
          if (
            event.type === "response.incomplete" &&
            event.response.incomplete_details?.reason !== "max_output_tokens"
          )
            throw new Error(
              `OpenAI Responses incomplete: ${event.response.incomplete_details?.reason ?? "unknown"}`,
            );
          for (const item of event.response.output) itemDone(item);
          const usage = event.response.usage;
          if (usage) {
            const cached = usage.input_tokens_details?.cached_tokens ?? 0;
            if (
              [usage.input_tokens, usage.output_tokens, usage.total_tokens, cached].every(
                (n) => Number.isSafeInteger(n) && n >= 0,
              ) &&
              cached <= usage.input_tokens
            ) {
              output.usageAvailable = true;
              output.cacheUsageAvailable = usage.input_tokens_details?.cached_tokens !== undefined;
              output.usage.input = usage.input_tokens - cached;
              output.usage.cacheRead = cached;
              output.usage.output = usage.output_tokens;
              output.usage.totalTokens = usage.total_tokens;
              output.usage.reasoning = usage.output_tokens_details?.reasoning_tokens;
            }
          }
          output.responseId = event.response.id;
          output.responseModel = event.response.model;
          output.rawStopReason = event.response.status;
          output.stopReason =
            event.type === "response.incomplete" ? "length" : complete.size ? "toolUse" : "stop";
          terminal = true;
          break;
        }
      }
    }
    if (options.signal?.aborted) throw new Error("Request aborted");
    if (!terminal) throw new Error("Stream ended without response.completed");
    for (const key of blocks.keys()) close(key);
    for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const)
      output.usage.cost[key] = (output.usage[key] * model.cost[key]) / 1e6;
    output.usage.cost.total = Object.values(output.usage.cost)
      .slice(0, 4)
      .reduce((a, b) => a + b, 0);
    events.push({
      type: "done",
      reason: output.stopReason as "stop" | "toolUse" | "length",
      message: output,
    });
  }
}
