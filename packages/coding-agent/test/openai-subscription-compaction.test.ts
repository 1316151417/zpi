import { expect, it } from "vitest";
import { normalizeContext } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { completeSummarization } from "../src/core/compaction.ts";

it.each([false, true])("completes native OpenAI summarization with subscription=%s", async (subscription) => {
  const model = {
    ...fakeModel("https://api.openai.com/v1"),
    api: "openai-responses" as const,
    id: "gpt-6.1-terra",
    ...(subscription ? { auth: "chatgpt" as const } : {}),
  };
  const context = normalizeContext({ messages: [{ role: "user", content: "Summarize this", timestamp: 0 }] });
  let body: Record<string, unknown> = {};
  const result = await completeSummarization(model, context, {
    apiKey: "fake-local-key",
    maxRetries: 0,
    fetch: async (_url, options) => {
      body = JSON.parse(String(options?.body));
      if (subscription && body.prompt_cache_options)
        return new Response(JSON.stringify({ error: { message: "prompt_cache_options is not supported" } }), {
          status: 400,
        });
      return new Response(
        `data: ${JSON.stringify({
          type: "response.completed",
          response: {
            id: "summary",
            model: model.id,
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                id: "message",
                status: "completed",
                content: [{ type: "output_text", text: "Summary retained", annotations: [] }],
              },
            ],
          },
        })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    },
  });
  expect(result.stopReason).toBe("stop");
  expect(result.content).toMatchObject([{ type: "text", text: "Summary retained" }]);
  expect(body).not.toHaveProperty("prompt_cache_key");
  expect(body).not.toHaveProperty("prompt_cache_retention");
  if (subscription) expect(body).not.toHaveProperty("prompt_cache_options");
  else expect(body.prompt_cache_options).toEqual({ mode: "explicit", ttl: "30m" });
});
