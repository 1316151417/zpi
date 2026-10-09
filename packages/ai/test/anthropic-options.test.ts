import { Type } from "typebox";
import { expect, it } from "vitest";
import { type AnthropicOptions, stream, streamSimple } from "../src/api/anthropic-messages.ts";
import type { JsonObject, Model, SimpleStreamOptions } from "../src/types.ts";
import { editableReasoningConfig } from "../src/utils/reasoning.ts";
import { hasToolRedefinitions, normalizeContext, toToolDeclaration } from "../src/utils/transcript.ts";
import { getModel } from "./helpers/anthropic.ts";

const context = normalizeContext({
  systemPrompt: "system <skills>skill</skills>",
  tools: [{ name: "read", description: "Read", parameters: Type.Object({ path: Type.String() }) }],
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
});

async function capture(model: Model<"anthropic-messages">, options: SimpleStreamOptions = {}) {
  let payload: JsonObject = {};
  await streamSimple(model, context, {
    apiKey: "test-key",
    ...options,
    onPayload: (value) => {
      payload = value as JsonObject;
      throw new Error("captured");
    },
  }).result();
  return payload;
}

it("disables thinking explicitly and selects native adaptive effort without OpenAI parameters", async () => {
  const model = { ...getModel(), thinkingLevelMap: { xhigh: "xhigh" } };
  expect((await capture(model, { reasoning: "off" })).thinking).toEqual({ type: "disabled" });
  const payload = await capture(model, { reasoning: "xhigh", temperature: 0.2 });
  expect(payload.thinking).toEqual({ type: "adaptive", display: "summarized" });
  expect(payload.output_config).toEqual({ effort: "xhigh" });
  expect(payload).not.toHaveProperty("reasoning_effort");
  expect(payload).not.toHaveProperty("temperature");
});

it("keeps answer room when a custom thinking budget meets a caller's output limit", async () => {
  const model = { ...getModel(), compat: { forceAdaptiveThinking: false }, maxTokens: 4096 };
  const payload = await capture(model, {
    reasoning: "high",
    maxTokens: 2048,
    thinkingBudgets: { high: 8192 },
  });
  expect(payload.max_tokens).toBe(4096);
  expect(payload.thinking).toEqual({ type: "enabled", budget_tokens: 3072, display: "summarized" });
});

it("preserves an explicit native thinking-level budget", async () => {
  const model = {
    ...getModel(),
    compat: { forceAdaptiveThinking: false },
    thinkingLevelMap: { low: { thinking: { type: "enabled", budget_tokens: 4096 } } },
  };
  expect((await capture(model, { reasoning: "low" })).thinking).toEqual({
    type: "enabled",
    budget_tokens: 4096,
  });
});

it("retains strict sampling through tool declarations and sends Anthropic strict schemas", async () => {
  const tool = toToolDeclaration({
    name: "read",
    description: "Read",
    parameters: Type.Object({ path: Type.String(), limit: Type.Optional(Type.Number()) }),
    constrainedSampling: { type: "json_schema", strict: "require" },
  });
  const transcript = normalizeContext({ tools: [tool], messages: [] });
  expect(
    hasToolRedefinitions(
      normalizeContext({
        tools: [tool],
        messages: [
          {
            role: "system",
            content: "",
            timestamp: 1,
            toolsAdded: [{ ...tool, constrainedSampling: { type: "json_schema", strict: "prefer" } }],
          },
        ],
      }).messages,
    ),
  ).toBe(true);
  let payload: JsonObject = {};
  await stream({ ...getModel(), compat: { supportsStrictTools: true } }, transcript, {
    apiKey: "test-key",
    onPayload: (value) => {
      payload = value as JsonObject;
      throw new Error("captured");
    },
  }).result();
  expect((payload.tools as JsonObject[])[0]).toMatchObject({
    strict: true,
    input_schema: {
      additionalProperties: false,
      required: ["path", "limit"],
      properties: { limit: { anyOf: [{ type: "number" }, { type: "null" }] } },
    },
  });
});

it("edits native reasoning mappings and applies arbitrary user level names on the Anthropic request", async () => {
  const original = getModel();
  const model = { ...original, reasoningConfig: editableReasoningConfig(original) };
  const payload = await capture(model, { reasoning: "none" });
  expect(payload.thinking).toEqual({ type: "disabled" });
  const custom = {
    ...original,
    reasoningConfig: {
      levels: ["fast", "deep"],
      map: '{"thinking":{"type":"adaptive"},"output_config":{"effort": reasoningLevel == "fast" ? "low" : "high"}}',
    },
  };
  expect((await capture(custom, { reasoning: "fast" })).output_config).toEqual({ effort: "low" });
  const budget = {
    ...original,
    maxTokens: 4096,
    compat: { forceAdaptiveThinking: false },
    reasoningConfig: { levels: ["deep"], map: '{"thinking":{"type":"enabled","budget_tokens":8192}}' },
  };
  expect((await capture(budget, { reasoning: "deep" })).thinking).toEqual({
    type: "enabled",
    budget_tokens: 3072,
  });
});

it("replays system and tool changes with native additions while keeping tool results adjacent to calls", async () => {
  const model = {
    ...getModel(),
    compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
  };
  let payload: JsonObject = {};
  await stream(
    model,
    normalizeContext({
      tools: [{ name: "read", description: "Read", parameters: Type.Object({}) }],
      messages: [
        { role: "user", content: "read", timestamp: 1 },
        {
          role: "system",
          content: "new instructions",
          toolsAdded: [{ name: "edit", description: "Edit", parameters: Type.Object({}) }],
          timestamp: 2,
        },
        { role: "user", content: "continue", timestamp: 3 },
      ],
    }),
    {
      apiKey: "test-key",
      onPayload: (value) => {
        payload = value as JsonObject;
        throw new Error("captured");
      },
    },
  ).result();
  const tools = payload.tools as JsonObject[];
  expect(tools.find((tool) => tool.name === "edit")).toMatchObject({ defer_loading: true });
  expect(JSON.stringify(payload.messages)).toContain('"type":"tool_addition"');
  expect(tools.find((tool) => tool.name === "read")).toHaveProperty("cache_control");
});

it("uses OAuth identity and canonical tool names while retaining custom tool names", async () => {
  const payload = await capture(getModel(), { apiKey: "sk-ant-oat-local-test" });
  expect(JSON.stringify(payload.system)).toContain("You are Claude Code");
  expect((payload.tools as JsonObject[])[0].name).toBe("Read");
});

it.each(["none", "short", "long"] as const)(
  "uses %s cache retention with session affinity",
  async (cacheRetention) => {
    let headers = new Headers();
    let payload: JsonObject = {};
    const model = { ...getModel(), compat: { sendSessionAffinityHeaders: true } };
    const result = await stream(model, context, {
      apiKey: "test-key",
      sessionId: "session",
      cacheRetention,
      fetch: (async (_url, init) => {
        headers = new Headers(init?.headers);
        payload = JSON.parse(String(init?.body)) as JsonObject;
        return new Response(
          [
            {
              type: "message_start",
              message: { id: "cache", model: model.id, usage: { input_tokens: 10, output_tokens: 0 } },
            },
            { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
            { type: "message_stop" },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(""),
        );
      }) as typeof fetch,
    } satisfies AnthropicOptions).result();
    expect(headers.get("x-session-affinity")).toBe(cacheRetention === "none" ? null : "session");
    const system = (payload.system as JsonObject[])[0];
    expect(system.cache_control).toEqual(
      cacheRetention === "none"
        ? undefined
        : {
            type: "ephemeral",
            ...(cacheRetention === "long" ? { ttl: "1h" } : {}),
          },
    );
    expect(result.usageAvailable).toBe(true);
    expect(result.contextBreakdown?.find((item) => item.source === "system_prompt")?.chars).toBeGreaterThan(
      0,
    );
    expect(result.contextBreakdown?.find((item) => item.source === "skills")?.chars).toBeGreaterThan(0);
  },
);
