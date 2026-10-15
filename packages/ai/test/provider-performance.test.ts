import { setTimeout as delay } from "node:timers/promises";
import { expect, it } from "vitest";
import type { ModelPerformanceSample, ProviderApi } from "zpi-ai";
import { normalizeContext, streamSimple } from "zpi-ai";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";
import { getModel } from "./helpers/anthropic.ts";

function delayedSse(events: unknown[]) {
  return new Response(
    new ReadableStream({
      async start(controller) {
        for (const event of events) {
          await delay(20);
          const type = (event as { type?: string }).type;
          controller.enqueue(
            new TextEncoder().encode(`${type ? `event: ${type}\n` : ""}data: ${JSON.stringify(event)}\n\n`),
          );
        }
        controller.close();
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

function frames(api: ProviderApi): unknown[] {
  if (api === "openai-completions")
    return [
      chunk({}),
      chunk({ reasoning_content: "plan" }),
      chunk({ content: "hello" }),
      {
        ...chunk({}),
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 85,
          total_tokens: 95,
          completion_tokens_details: { reasoning_tokens: 20 },
        },
      },
      chunk({}, "stop"),
    ];
  if (api === "anthropic-messages")
    return [
      {
        type: "message_start",
        message: { id: "m", model: "fake", usage: { input_tokens: 10, output_tokens: 1 } },
      },
      { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "plan" } },
      { type: "content_block_delta", index: 0, delta: { type: "thinking_delta", thinking: "hello" } },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 85, output_tokens_details: { thinking_tokens: 20 } },
      },
      { type: "message_stop" },
    ];
  return [
    { type: "response.created", response: { id: "r" } },
    { type: "response.reasoning_summary_text.delta", item_id: "think", summary_index: 0, delta: "plan" },
    { type: "response.output_text.delta", item_id: "text", content_index: 0, delta: "hello" },
    {
      type: "response.completed",
      response: {
        id: "r",
        model: "fake",
        status: "completed",
        output: [],
        usage: {
          input_tokens: 10,
          output_tokens: 85,
          total_tokens: 95,
          output_tokens_details: { reasoning_tokens: 20 },
        },
      },
    },
  ];
}

it.each<ProviderApi>(["openai-completions", "openai-responses", "anthropic-messages"])(
  "%s measures the actual retry attempt and total output usage without adding reasoning twice",
  async (api) => {
    let attempts = 0;
    let sentAt = 0;
    let firstAt = 0;
    const samples: ModelPerformanceSample[] = [];
    const model =
      api === "anthropic-messages" ? getModel() : { ...fakeModel("https://example.test/v1"), api };
    const result = await streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: "isolated",
      onPayload: async () => {
        await delay(100);
      }, // Local preparation is outside TTFT.
      onPerformance: (sample) => {
        if (sample.ttftMs && !firstAt) firstAt = performance.now();
        samples.push(sample);
      },
      fetch: async () => {
        attempts++;
        sentAt = performance.now();
        if (attempts === 1)
          return new Response('{"error":{"message":"retry"}}', {
            status: 503,
            headers: { "retry-after-ms": "100", "content-type": "application/json" },
          });
        return delayedSse(frames(api));
      },
    }).result();
    expect(result.stopReason, result.errorMessage).toBe("stop");
    expect(attempts).toBe(2);
    expect(samples.filter((s) => Object.keys(s).length === 0)).toHaveLength(2);
    const first = samples.find((s) => s.ttftMs);
    expect(first?.outputTokens).toBeUndefined();
    expect(Math.abs((first?.ttftMs ?? 0) - (firstAt - sentAt))).toBeLessThan(50);
    expect(samples.at(-1)?.outputTokens).toBe(85);
    expect(samples.at(-1)?.generationMs).toBeGreaterThan(0);
    expect(result.usage.reasoning).toBe(20);
  },
);

it.each([true, false])(
  "uses tool-name TTFT and output-only streaming counts, with final usage %s",
  async (finalUsage) => {
    const samples: ModelPerformanceSample[] = [];
    const result = await streamSimple(
      fakeModel("https://example.test/v1"),
      normalizeContext({ messages: [] }),
      {
        apiKey: "isolated",
        onPerformance: (sample) => samples.push(sample),
        fetch: async () =>
          delayedSse([
            chunk({ tool_calls: [{ index: 0, id: "call", type: "function", function: { name: "read" } }] }),
            {
              ...chunk({ tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] }),
              usage: { completion_tokens: 40 },
            },
            chunk({ tool_calls: [{ index: 0, function: { arguments: '"a"}' } }] }),
            ...(finalUsage ? [{ ...chunk({}), choices: [], usage: { completion_tokens: 60 } }] : []),
            chunk({}, "tool_calls"),
          ]),
      },
    ).result();
    expect(result.stopReason, result.errorMessage).toBe("toolUse");
    expect(samples.find((sample) => sample.ttftMs)?.outputTokens).toBeUndefined();
    expect(samples.some((sample) => sample.outputTokens === 40 && (sample.generationMs ?? 0) > 0)).toBe(true);
    expect(samples.at(-1)?.outputTokens).toBe(finalUsage ? 60 : undefined);
  },
);
