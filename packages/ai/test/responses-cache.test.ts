import type { ResponseInput } from "openai/resources/responses/responses";
import { expect, it } from "vitest";
import { emptyAssistant, normalizeContext, streamSimple } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { responsesCache } from "../src/api/responses-cache.ts";
import type { CacheRetention, Model } from "../src/types.ts";
import { measureContextBreakdown } from "../src/utils/context-breakdown.ts";

const model: Model = {
  ...fakeModel("https://api.openai.com/v1"),
  api: "openai-responses",
  id: "gpt-6.1-sol",
};

it.each([
  ["gpt-6.1-sol", "long", { mode: "implicit", ttl: "30m" }, undefined],
  ["gpt-5.6-2026-07-01", "short", { mode: "implicit", ttl: "30m" }, undefined],
  ["gpt-5.6", "none", { mode: "explicit", ttl: "30m" }, undefined],
  ["gpt-5.5", "long", undefined, "24h"],
  ["gpt-5.5-pro", "short", undefined, undefined],
  ["gpt-5.4", "short", undefined, "in_memory"],
  ["gpt-5.2-2025-12-11", "long", undefined, "24h"],
  ["gpt-4.1", "long", undefined, "24h"],
  ["gpt-4.1-mini", "long", undefined, undefined],
  ["gateway-alias", "long", undefined, undefined],
  ["gpt-5.5", "none", undefined, undefined],
] as const)(
  "maps %s cache retention %s to supported model controls",
  (id, cacheRetention, modern, legacy) => {
    const result = responsesCache({ ...model, id }, { cacheRetention, sessionId: "stable-key" }, []);
    expect(result).toEqual({
      input: [],
      ...(cacheRetention !== "none" ? { prompt_cache_key: "stable-key" } : {}),
      ...(modern ? { prompt_cache_options: modern } : {}),
      ...(legacy ? { prompt_cache_retention: legacy } : {}),
    });
  },
);

it("keeps default affinity and ChatGPT's legacy retention restrictions", () => {
  expect(responsesCache(model, { sessionId: "stable-key" }, [])).toEqual({
    input: [],
    prompt_cache_key: "stable-key",
  });
  expect(
    responsesCache({ ...model, id: "gpt-5.4", auth: "chatgpt" }, { cacheRetention: "long" }, []),
  ).toEqual({ input: [] });
});

it.each<ResponseInput[number]>([
  { role: "assistant", content: "Stable answer", phase: "final_answer" },
  {
    role: "user",
    content: [
      { type: "input_text", text: "Stable text" },
      { type: "input_image", image_url: "data:image/png;base64,YWJj", detail: "auto" },
    ],
  },
  { type: "function_call_output", call_id: "call", output: "Stable tool result" },
])("places skipCacheWrite before the transient prompt without mutating history: %j", (stable) => {
  const input: ResponseInput = [stable, { role: "user", content: "TRANSIENT PROMPT" }];
  const before = JSON.stringify(input);
  const result = responsesCache(model, { skipCacheWrite: true }, input);
  expect(result.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
  expect(JSON.stringify(result.input[0])).toContain('"prompt_cache_breakpoint":{"mode":"explicit"}');
  expect(result.input[1]).toEqual(input[1]);
  expect(JSON.stringify(input)).toBe(before);
});

it("does not put markers inside tool arguments and disables caching when no stable boundary exists", () => {
  const input: ResponseInput = [
    { type: "function_call", call_id: "call", name: "read", arguments: '{"content":"tool arguments"}' },
    { role: "user", content: "TRANSIENT PROMPT" },
  ];
  expect(responsesCache(model, { skipCacheWrite: true }, input)).toEqual({
    input,
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  });
  expect(responsesCache(model, { skipCacheWrite: true, cacheRetention: "none" }, input)).toEqual({
    input,
    prompt_cache_options: { mode: "explicit", ttl: "30m" },
  });
});

it("counts tool-result text accurately after adding a cache breakpoint", () => {
  const request = responsesCache(model, { skipCacheWrite: true }, [
    { type: "function_call_output", call_id: "call", output: "Stable tool result" },
    { role: "user", content: "Transient prompt" },
  ]);
  expect(measureContextBreakdown(JSON.parse(JSON.stringify(request)))).toContainEqual({
    source: "messages",
    chars: "Stable tool resultTransient prompt".length,
  });
});

it.each<CacheRetention>(["none", "long"])(
  "sends cache controls in the actual Responses payload: %s",
  async (cacheRetention) => {
    const assistant = emptyAssistant(model);
    assistant.content = [{ type: "text", text: "Stable answer", phase: "final_answer" }];
    const context = normalizeContext({
      messages: [
        { role: "user", content: "Stable question", timestamp: 0 },
        assistant,
        { role: "user", content: "TRANSIENT PROMPT", timestamp: 1 },
      ],
    });
    let body: Record<string, unknown> = {};
    await streamSimple(model, context, {
      apiKey: "fake",
      cacheRetention,
      skipCacheWrite: true,
      fetch: (async (_url, options) => {
        body = JSON.parse(String(options?.body));
        return new Response(
          JSON.stringify({ id: "resp_test", model: model.id, status: "completed", output: [] }),
          { headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    }).result();
    expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
    expect(body.input).toEqual([
      { role: "user", content: "Stable question" },
      {
        role: "assistant",
        phase: "final_answer",
        content:
          cacheRetention === "none"
            ? "Stable answer"
            : [{ type: "input_text", text: "Stable answer", prompt_cache_breakpoint: { mode: "explicit" } }],
      },
      { role: "user", content: "TRANSIENT PROMPT" },
    ]);
    expect(assistant.content[0]).toEqual({ type: "text", text: "Stable answer", phase: "final_answer" });
  },
);
