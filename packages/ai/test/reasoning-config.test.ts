import { expect, it } from "vitest";
import { chunk, fakeModel } from "../../../tests/fake-server.ts";
import {
  canControlThinking,
  defaultThinkingLevel,
  editableReasoningConfig,
  normalizeContext,
  presetModels,
  reasoningParameters,
  streamSimple,
  thinkingChoices,
  validateReasoningConfig,
} from "../src/index.ts";

const config = {
  levels: ["disabled", "balanced", "thorough"],
  map: `reasoningLevel == "disabled"
    ? {"thinking": {"type": "disabled"}}
    : {"thinking": {"type": "enabled"}, "reasoning_effort": reasoningLevel == "balanced" ? "low" : "high"}`,
};

it("custom levels preserve their order and map independently of provider effort names", () => {
  const model = { ...fakeModel(""), reasoningConfig: config };
  validateReasoningConfig(config);
  expect(thinkingChoices(model)).toEqual(config.levels);
  expect(defaultThinkingLevel(model)).toBe("thorough");
  expect(canControlThinking(model, "balanced")).toBe(true);
  expect(canControlThinking(model, "xhigh")).toBe(false);
  expect(reasoningParameters(model, "disabled")).toEqual({ thinking: { type: "disabled" } });
  expect(reasoningParameters(model, "balanced")).toEqual({
    thinking: { type: "enabled" },
    reasoning_effort: "low",
  });
  expect(reasoningParameters(model)).toEqual({ thinking: { type: "enabled" }, reasoning_effort: "high" });
  expect(() => reasoningParameters(model, "xhigh")).toThrow("Unsupported reasoning level");
  expect(defaultThinkingLevel({ ...model, defaultThinkingLevel: "balanced" })).toBe("balanced");
});

it("domestic and GPT recommendations seed complete editable configurations", () => {
  for (const preset of ["deepseek", "mimo-api", "zhipu-coding", "openai-chatgpt"]) {
    const models = presetModels(preset);
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      const resolved = { reasoning: model.reasoning ?? true, compat: model.compat, ...model };
      const editable = editableReasoningConfig(resolved);
      validateReasoningConfig(editable);
      for (const level of thinkingChoices(resolved).filter((level) => level !== "minimal")) {
        expect(
          reasoningParameters({ ...resolved, reasoningConfig: editable }, level === "off" ? "none" : level),
        ).toEqual(reasoningParameters(resolved, level));
      }
    }
  }
  const binary = {
    ...fakeModel(""),
    compat: { thinkingFormat: "deepseek" as const, supportsReasoningEffort: false },
  };
  expect(editableReasoningConfig(binary).levels).toEqual(["none", "high"]);
});

it("invalid configurations cannot bypass validation or execute JavaScript", () => {
  for (const invalid of [
    { ...config, levels: [] },
    { ...config, levels: [" "] },
    { ...config, levels: ["low", "low"] },
    { ...config, map: "" },
    { ...config, map: 'reasoningLevel == "balanced" ? {} : null' },
    { ...config, map: '{"thinking_budget": 1 / 0}' },
    { ...config, map: '{"headers": {"Authorization": "override"}}' },
    { ...config, map: "globalThis.process.exit()" },
    { ...config, map: '{"thinking": unknownVariable}' },
  ])
    expect(() => validateReasoningConfig(invalid)).toThrow();
  expect(
    reasoningParameters(
      { ...fakeModel(""), reasoningConfig: { levels: ["custom"], map: '{"thinking_budget": 2 * 1024}' } },
      "custom",
    ),
  ).toEqual({ thinking_budget: 2048 });
});

it("custom CEL mappings reach both Chat Completions and Responses through the same stream interface", async () => {
  for (const api of ["openai-completions", "openai-responses"] as const) {
    let payload: Record<string, unknown> = {};
    const model = {
      ...fakeModel("http://test.invalid/v1"),
      api,
      reasoningConfig: {
        levels: ["balanced"],
        map: '{"reasoning_effort": reasoningLevel == "balanced" ? "medium" : "high"}',
      },
    };
    const output = await streamSimple(model, normalizeContext({ messages: [] }), {
      apiKey: "isolated",
      reasoning: "balanced",
      fetch: async (_, init) => {
        payload = JSON.parse(String(init?.body));
        const text =
          api === "openai-completions"
            ? `data: ${JSON.stringify(chunk({ content: "ok" }, "stop"))}\n\ndata: [DONE]\n\n`
            : `data: ${JSON.stringify({
                type: "response.completed",
                response: {
                  status: "completed",
                  output: [],
                  usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 },
                },
              })}\n\n`;
        return new Response(text, { headers: { "content-type": "text/event-stream" } });
      },
    }).result();
    expect(output.errorMessage).toBeUndefined();
    expect(output.stopReason).not.toBe("error");
    expect(
      api === "openai-completions"
        ? payload.reasoning_effort
        : (payload.reasoning as { effort: string }).effort,
    ).toBe("medium");
  }
});
