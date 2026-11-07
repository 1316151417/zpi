import { expect, test } from "vitest";
import { ModelRuntime } from "../src/index.ts";
import { runtimeFor, selectModel } from "../src/runtime.ts";

test("qualified names and provider aliases take precedence over another provider's bare model ID", async () => {
  const runtime = await ModelRuntime.create();
  const model = (id: string) => ({
    id,
    name: id,
    input: ["text"] as ["text"],
    reasoning: false,
    contextWindow: 128000,
    maxTokens: 8192,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  });
  runtime.registerProvider("first", {
    apiKey: "test",
    models: [model("second"), model("second/target"), model("duplicate")],
  });
  runtime.registerProvider("second", { apiKey: "test", models: [model("target"), model("duplicate")] });
  expect((await selectModel(runtime, "second")).provider).toBe("second");
  expect((await selectModel(runtime, "second/target")).provider).toBe("second");
  await expect(selectModel(runtime, "duplicate")).rejects.toThrow("Ambiguous model");
});

test("environment discovery skips blank or control-bearing credentials and tries the next alias", async () => {
  let headers: Headers | undefined;
  const runtime = await runtimeFor({
    zpi: {
      fetch: async (input, init) => {
        headers = new Request(input, init).headers;
        return new Response(
          JSON.stringify({
            type: "error",
            error: { type: "invalid_request_error", message: "Test transport" },
          }),
          { status: 400, headers: { "content-type": "application/json" } },
        );
      },
    },
    env: {
      DEEPSEEK_API_KEY: "   ",
      ZHIPU_API_KEY: "bad\nkey",
      ZHIPU_CODING_API_KEY: "valid-coding-key",
    },
  });
  const models = await runtime.getAvailable();
  expect(models.some((model) => model.provider === "deepseek")).toBe(false);
  const model = await selectModel(runtime, "zhipu-coding");
  for await (const _event of runtime.streamSimple(
    model,
    { messages: [{ role: "user", content: "Hi", timestamp: 1 }] },
    { maxRetries: 0 },
  )) {
    /* Drain the intercepted request. */
  }
  expect(headers?.get("x-api-key")).toBe("valid-coding-key");
});
