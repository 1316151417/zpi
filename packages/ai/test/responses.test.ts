import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { emptyAssistant, normalizeContext, presetModels, streamSimple } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { responsesInput } from "../src/api/openai-responses.ts";
import type { Message, Model } from "../src/types.ts";

export const responsesModel = (): Model => ({
  ...fakeModel("https://api.openai.com/v1"),
  api: "openai-responses",
  auth: "chatgpt",
  compat: { supportsReasoningEffort: true },
});
const textItem = {
  type: "message",
  id: "msg_test",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: "你好", annotations: [] }],
};
const reasonItem = {
  type: "reasoning",
  id: "rs_test",
  summary: [{ type: "summary_text", text: "计划" }],
  encrypted_content: "encrypted-reasoning",
};
const callItem = {
  type: "function_call",
  id: "fc_test",
  call_id: "call_test",
  name: "read",
  namespace: "zpi",
  arguments: '{"path":"README.md"}',
  status: "completed",
};
function terminal(output: unknown[], type = "response.completed", reason?: string) {
  return {
    type,
    response: {
      id: "resp_test",
      model: "fake",
      status: type === "response.completed" ? "completed" : "incomplete",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: 7,
        total_tokens: 17,
        input_tokens_details: { cached_tokens: 2 },
        output_tokens_details: { reasoning_tokens: 3 },
      },
      ...(reason ? { incomplete_details: { reason } } : {}),
    },
  };
}
function sse(events: unknown[]) {
  return new Response(events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}

describe("Responses protocol and portable transcripts", () => {
  it("requests summaries for custom reasoning objects and final request overrides", async () => {
    for (const override of [undefined, { effort: "high" }, { effort: "high", summary: "detailed" }]) {
      let request: Record<string, unknown> = {};
      const model: Model = {
        ...responsesModel(),
        reasoningConfig: { levels: ["balanced"], map: '{"reasoning": {"effort": "medium"}}' },
      };
      const result = await streamSimple(model, normalizeContext({ messages: [] }), {
        apiKey: "fake",
        reasoning: "balanced",
        onPayload: (payload) => ({ ...(payload as object), ...(override ? { reasoning: override } : {}) }),
        fetch: (async (_url, options) => {
          request = JSON.parse(String(options?.body));
          return sse([terminal([textItem])]);
        }) as typeof fetch,
      }).result();
      expect(result.stopReason).toBe("stop");
      expect(request.reasoning).toEqual({
        effort: override?.effort ?? "medium",
        summary: override?.summary ?? "auto",
      });
      expect(result.providerThinkingLevel).toBe(override?.effort ?? "medium");
    }
  });
  it.each([
    [{ type: "response.reasoning_summary_text.done", item_id: "rs_test", summary_index: 0, text: "计划" }],
    [
      {
        type: "response.reasoning_summary_part.done",
        item_id: "rs_test",
        summary_index: 0,
        part: { type: "summary_text", text: "计划" },
      },
    ],
    [{ type: "response.output_item.done", item: reasonItem }],
    [
      {
        type: "response.reasoning_summary_text.delta",
        item_id: "rs_test",
        summary_index: 0,
        delta: "计",
      },
    ],
  ])("fills completed summaries even after an empty or partial reasoning start", async (...events) => {
    const result = await streamSimple(responsesModel(), normalizeContext({ messages: [] }), {
      apiKey: "fake",
      fetch: (async () =>
        sse([
          { type: "response.output_item.added", item: { ...reasonItem, summary: [] } },
          ...events,
          terminal([reasonItem, textItem]),
        ])) as typeof fetch,
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.content[0]).toEqual({
      type: "thinking",
      thinking: "计划",
      thinkingSignature: JSON.stringify(reasonItem),
    });
  });
  it("preserves reasoning_text events and completed content when no summary is returned", async () => {
    const item = { ...reasonItem, summary: [], content: [{ type: "reasoning_text", text: "计划" }] };
    const stream = streamSimple(responsesModel(), normalizeContext({ messages: [] }), {
      apiKey: "fake",
      fetch: (async () =>
        sse([
          { type: "response.output_item.added", item: { ...item, content: [] } },
          { type: "response.reasoning_text.delta", item_id: item.id, content_index: 0, delta: "计" },
          { type: "response.reasoning_text.done", item_id: item.id, content_index: 0, text: "计划" },
          { type: "response.output_item.done", item },
          terminal([item, textItem]),
        ])) as typeof fetch,
    });
    const deltas: string[] = [];
    for await (const event of stream) if (event.type === "thinking_delta") deltas.push(event.delta);
    expect(deltas.join("")).toBe("计划");
    expect((await stream.result()).content[0]).toEqual({
      type: "thinking",
      thinking: "计划",
      thinkingSignature: JSON.stringify(item),
    });
  });
  it("sends each GPT effort through Responses without collapsing medium, xhigh or max", async () => {
    for (const metadata of presetModels("openai-chatgpt")) {
      const model: Model = { ...responsesModel(), ...metadata, input: ["text", "image"], reasoning: true };
      for (const effort of [
        undefined,
        ...(metadata.id === "gpt-6-luna" ? ["off" as const] : []),
        "low",
        "medium",
        "high",
        "xhigh",
        "max",
      ] as const) {
        let request: Record<string, unknown> = {};
        const result = await streamSimple(model, normalizeContext({ messages: [] }), {
          apiKey: "fake",
          reasoning: effort,
          fetch: (async (_url, options) => {
            request = JSON.parse(String(options?.body));
            return sse([terminal([textItem])]);
          }) as typeof fetch,
        }).result();
        expect(result.stopReason).toBe("stop");
        expect(request.reasoning).toMatchObject({ effort: effort === "off" ? "none" : (effort ?? "medium") });
      }
    }
  });
  it("streams text, reasoning, tools and usage; replays encrypted reasoning only to its originating model", async () => {
    let body: Record<string, unknown> = {};
    const model = responsesModel();
    const stream = streamSimple(
      model,
      normalizeContext({
        systemPrompt: "instructions",
        messages: [{ role: "user", content: "read it", timestamp: 0 }],
        tools: [
          { name: "read", description: "Read a file", parameters: Type.Object({ path: Type.String() }) },
        ],
      }),
      {
        apiKey: "oauth-secret",
        reasoning: "high",
        maxTokens: 100,
        temperature: 0.5,
        samplingParams: { previous_response_id: "must-not-send", metadata: { test: true } },
        fetch: (async (_url, init) => {
          body = JSON.parse(String(init?.body));
          expect(new Headers(init?.headers).get("authorization")).toBe("Bearer oauth-secret");
          return sse([
            { type: "response.output_text.delta", item_id: "msg_test", content_index: 0, delta: "你好" },
            { type: "response.output_item.done", item: textItem },
            {
              type: "response.reasoning_summary_text.delta",
              item_id: "rs_test",
              summary_index: 0,
              delta: "计划",
            },
            { type: "response.output_item.done", item: reasonItem },
            { type: "response.output_item.added", item: { ...callItem, arguments: "" } },
            { type: "response.function_call_arguments.delta", item_id: "fc_test", delta: '{"path":' },
            { type: "response.function_call_arguments.delta", item_id: "fc_test", delta: '"README.md"}' },
            { type: "response.output_item.done", item: callItem },
            terminal([textItem, reasonItem, callItem]),
          ]);
        }) as typeof fetch,
      },
    );
    const types: string[] = [];
    for await (const event of stream) types.push(event.type);
    const output = await stream.result();
    expect(output.stopReason).toBe("toolUse");
    expect(output.content).toEqual([
      { type: "text", text: "你好", textSignature: "msg_test" },
      { type: "thinking", thinking: "计划", thinkingSignature: JSON.stringify(reasonItem) },
      {
        type: "toolCall",
        id: "call_test|fc_test",
        namespace: "zpi",
        name: "read",
        arguments: { path: "README.md" },
      },
    ]);
    expect(output.usage).toMatchObject({ input: 8, cacheRead: 2, output: 7, reasoning: 3, totalTokens: 17 });
    expect(types).toContain("toolcall_delta");
    expect(types.at(-1)).toBe("done");
    expect(body).toMatchObject({
      store: false,
      stream: true,
      instructions: "instructions",
      reasoning: { effort: "high" },
      tools: [{ type: "namespace", name: "zpi" }],
    });
    for (const key of ["max_output_tokens", "temperature", "metadata", "previous_response_id"])
      expect(body).not.toHaveProperty(key);
    const history: Message[] = [
      output,
      {
        role: "toolResult",
        toolCallId: "call_test|fc_test",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 0,
      },
    ];
    expect(responsesInput(model, normalizeContext({ messages: history }))).toContainEqual(reasonItem);
    const changed = responsesInput({ ...model, id: "other" }, normalizeContext({ messages: history }));
    expect(changed.some((item) => item.type === "reasoning")).toBe(false);
    expect(changed).toContainEqual(
      expect.objectContaining({
        type: "function_call_output",
        call_id: "call_test",
        output: "file contents",
      }),
    );
    let reverse: Record<string, unknown> = {};
    const completions = { ...model, api: "openai-completions", auth: undefined };
    await streamSimple(completions, normalizeContext({ messages: history }), {
      apiKey: "key",
      fetch: (async (_url, init) => {
        reverse = JSON.parse(String(init?.body));
        return sse([
          {
            id: "reply",
            model: "other",
            choices: [{ index: 0, delta: { content: "continued" }, finish_reason: "stop" }],
          },
        ]);
      }) as typeof fetch,
    }).result();
    expect(reverse.messages).toContainEqual(
      expect.objectContaining({ role: "tool", tool_call_id: "call_test", content: "file contents" }),
    );
    expect(JSON.stringify(reverse)).not.toContain("encrypted-reasoning");
    expect(JSON.stringify(reverse)).not.toContain("fc_test");
  });
  it("converts completion tools, images and interrupted turns without changing stored history", () => {
    const assistant = {
      ...emptyAssistant(fakeModel("")),
      stopReason: "toolUse" as const,
      content: [{ type: "toolCall" as const, id: "bad.call/id", name: "read", arguments: {} }],
    };
    const history: Message[] = [
      assistant,
      {
        role: "toolResult",
        toolCallId: "bad.call/id",
        toolName: "read",
        content: [{ type: "image", data: "abc", mimeType: "image/png" }],
        isError: false,
        timestamp: 0,
      },
      { ...assistant, stopReason: "aborted" },
      {
        role: "toolResult",
        toolCallId: "bad.call/id",
        toolName: "read",
        content: [{ type: "text", text: "orphan" }],
        isError: true,
        timestamp: 0,
      },
    ];
    const before = JSON.stringify(history);
    const input = responsesInput(responsesModel(), normalizeContext({ messages: history }));
    expect(input).toContainEqual(
      expect.objectContaining({ type: "function_call", call_id: "bad_call_id", namespace: "zpi" }),
    );
    expect(JSON.stringify(input)).toContain("data:image/png;base64,abc");
    expect(JSON.stringify(input)).not.toContain("orphan");
    expect(JSON.stringify(history)).toBe(before);
    const interrupted = responsesInput(
      responsesModel(),
      normalizeContext({ messages: [assistant, { role: "user", content: "continue", timestamp: 0 }] }),
    );
    expect(interrupted).toContainEqual(
      expect.objectContaining({ type: "function_call_output", output: "Tool execution was interrupted." }),
    );
  });
  it.each([
    [[{ type: "response.output_text.delta", item_id: "msg", content_index: 0, delta: "partial" }], "error"],
    [
      [
        {
          type: "response.failed",
          response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "oauth-secret" } },
        },
      ],
      "error",
    ],
    [[terminal([], "response.incomplete", "max_output_tokens")], "length"],
    [[terminal([], "response.incomplete", "content_filter")], "error"],
  ])("handles missing completion, usage errors and incomplete responses", async (events, reason) => {
    const output = await streamSimple(responsesModel(), normalizeContext({ messages: [] }), {
      apiKey: "oauth-secret",
      fetch: (async () => sse(events)) as typeof fetch,
    }).result();
    expect(output.stopReason).toBe(reason);
    expect(output.errorMessage ?? "").not.toContain("oauth-secret");
  });
  it("resolves fresh credentials per request and reports cancellation", async () => {
    let keys = 0;
    const controller = new AbortController();
    controller.abort();
    const output = await streamSimple(responsesModel(), normalizeContext({ messages: [] }), {
      signal: controller.signal,
      getApiKey: async () => {
        keys++;
        return "secret";
      },
    }).result();
    expect(output.stopReason).toBe("aborted");
    expect(keys).toBe(0);
  });
  it("cancels promptly while a shared credential refresh is pending", async () => {
    const controller = new AbortController();
    let release!: (key: string) => void;
    const pending = new Promise<string>((resolve) => {
      release = resolve;
    });
    const stream = streamSimple(responsesModel(), normalizeContext({ messages: [] }), {
      signal: controller.signal,
      getApiKey: () => pending,
    });
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
    release("renewed-key");
  });
});
