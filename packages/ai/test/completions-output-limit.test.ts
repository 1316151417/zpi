import { expect, it } from "vitest";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";
import { normalizeContext, streamSimple } from "../src/index.ts";
import type { ModelCompat } from "../src/types.ts";

it.each<{
  baseUrl: string;
  override?: ModelCompat["maxTokensField"];
  field: string;
}>([
  { baseUrl: "https://api.openai.com/v1", field: "max_completion_tokens" },
  { baseUrl: "https://api.openai.com/v1/", field: "max_completion_tokens" },
  { baseUrl: "https://eu.api.openai.com/v1", field: "max_completion_tokens" },
  { baseUrl: "https://api.deepseek.com", field: "max_tokens" },
  { baseUrl: "https://api.openai.com.example/v1", field: "max_tokens" },
  { baseUrl: "http://127.0.0.1:8000/v1", field: "max_tokens" },
  { baseUrl: "https://api.openai.com/v1", override: "max_tokens", field: "max_tokens" },
  { baseUrl: "https://custom.example/v1", override: "max_completion_tokens", field: "max_completion_tokens" },
])("sends $field to $baseUrl with explicit override $override", async ({ baseUrl, override, field }) => {
  let request: Record<string, unknown> = {};
  const result = await streamSimple(
    {
      ...fakeModel(baseUrl),
      id: "gpt-6.1-sol",
      compat: override ? { maxTokensField: override } : undefined,
    },
    normalizeContext({ messages: [{ role: "user", content: "你好", timestamp: 0 }] }),
    {
      apiKey: "fake-api-key",
      maxTokens: 1234,
      fetch: async (input, init) => {
        const sent = new Request(input, init);
        request = (await sent.json()) as Record<string, unknown>;
        expect(sent.url).toBe(`${baseUrl.replace(/\/$/, "")}/chat/completions`);
        if (baseUrl === "https://api.openai.com/v1" && !override && request.max_tokens !== undefined)
          return Response.json(
            { error: { message: "Unsupported parameter: max_tokens", code: "unsupported_parameter" } },
            { status: 400 },
          );
        return new Response(
          `data: ${JSON.stringify(chunk({ content: "你好" }))}\n\ndata: ${JSON.stringify(chunk({}, "stop"))}\n\ndata: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    },
  ).result();
  expect(result.stopReason, result.errorMessage).toBe("stop");
  expect(request[field]).toBe(1234);
  expect(request[field === "max_tokens" ? "max_completion_tokens" : "max_tokens"]).toBeUndefined();
});
