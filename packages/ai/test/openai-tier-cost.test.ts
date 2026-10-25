import { expect, it } from "vitest";
import { normalizeContext, streamSimple } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";

it.each(["openai-completions", "openai-responses"] as const)(
  "applies configured cost tiers to %s usage",
  async (api) => {
    const model = {
      ...fakeModel("https://provider.invalid/v1"),
      api,
      cost: {
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 0,
        tiers: [{ inputTokensAbove: 10, input: 3, output: 6, cacheRead: 0.3, cacheWrite: 0 }],
      },
    };
    const events =
      api === "openai-completions"
        ? [
            {
              id: "r",
              choices: [{ index: 0, delta: { role: "assistant", content: "answer" }, finish_reason: "stop" }],
              usage: {
                prompt_tokens: 20,
                completion_tokens: 5,
                total_tokens: 25,
                prompt_tokens_details: { cached_tokens: 4 },
              },
            },
          ]
        : [
            {
              type: "response.completed",
              response: {
                id: "r",
                status: "completed",
                output: [
                  {
                    type: "message",
                    id: "m",
                    role: "assistant",
                    status: "completed",
                    content: [{ type: "output_text", text: "answer", annotations: [] }],
                  },
                ],
                usage: {
                  input_tokens: 20,
                  output_tokens: 5,
                  total_tokens: 25,
                  input_tokens_details: { cached_tokens: 4 },
                },
              },
            },
          ];
    const result = await streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: "local",
      fetch: async () =>
        new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
          headers: { "content-type": "text/event-stream" },
        }),
    }).result();
    expect(result.stopReason).toBe("stop");
    expect(result.usage).toMatchObject({ input: 16, cacheRead: 4, output: 5 });
    expect(result.usage.cost.input).toBeCloseTo(48 / 1e6, 12);
    expect(result.usage.cost.output).toBeCloseTo(30 / 1e6, 12);
    expect(result.usage.cost.cacheRead).toBeCloseTo(1.2 / 1e6, 12);
    expect(result.usage.cost.total).toBeCloseTo(79.2 / 1e6, 12);
  },
);
