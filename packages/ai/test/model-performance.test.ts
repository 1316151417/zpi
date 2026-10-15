import { expect, it } from "vitest";
import type { AssistantMessageEvent, ModelPerformanceSample } from "zpi-ai";
import { emptyAssistant } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { MeasuredAssistantStream } from "../src/utils/model-performance.ts";

function fixture() {
  let now = 100;
  const samples: ModelPerformanceSample[] = [];
  const stream = new MeasuredAssistantStream({ onPerformance: (sample) => samples.push(sample) }, () => now);
  const message = emptyAssistant(fakeModel(""));
  const at = (time: number, event?: AssistantMessageEvent) => {
    now = time;
    stream.received();
    if (event) stream.push(event);
  };
  const delta = (time: number, text = "x") =>
    at(time, { type: "text_delta", contentIndex: 0, delta: text, partial: message });
  stream.startRequest();
  return { stream, samples, message, at, delta };
}

it.each(["text_delta", "thinking_delta", "toolcall_delta"] as const)(
  "counts the first nonempty %s, ignores connection/empty/end events, and pairs cumulative usage",
  (type) => {
    const f = fixture();
    f.at(200, { type: "start", partial: f.message });
    f.at(300, { type, contentIndex: 0, delta: "", partial: f.message });
    expect(f.samples.at(-1)).toEqual({});
    f.at(900, { type, contentIndex: 0, delta: "first", partial: f.message });
    expect(f.samples.at(-1)).toEqual({ ttftMs: 800 });
    f.delta(1900);
    f.stream.recordUsage(85);
    expect(f.samples.at(-1)).toEqual({ ttftMs: 800, outputTokens: 85, generationMs: 1000 });
    f.delta(2900);
    // Until fresh usage arrives, retain the paired sample instead of mixing 85 with 2 seconds.
    expect(f.samples.at(-1)?.generationMs).toBe(1000);
    f.at(10000, { type: "text_end", contentIndex: 0, content: "firstx", partial: f.message });
    f.stream.recordUsage(170);
    f.stream.end(f.message);
    expect(f.samples.at(-1)).toEqual({ ttftMs: 800, outputTokens: 170, generationMs: 2000, requestMs: 9900 });
  },
);

it.each(["text", "thinking", "toolCall"] as const)("accepts nonempty %s block starts", (type) => {
  const f = fixture();
  f.message.content = [
    type === "text"
      ? { type, text: "a" }
      : type === "thinking"
        ? { type, thinking: "a" }
        : { type, id: "call", name: "read", arguments: {} },
  ];
  f.at(900, {
    type: type === "text" ? "text_start" : type === "thinking" ? "thinking_start" : "toolcall_start",
    contentIndex: 0,
    partial: f.message,
  });
  expect(f.samples.at(-1)).toEqual({ ttftMs: 800 });
});

it.each([undefined, 0, -1, NaN, Infinity, 1.5])("omits invalid output usage %s", (count) => {
  const f = fixture();
  f.delta(900);
  f.delta(1900);
  f.stream.recordUsage(count);
  f.stream.end(f.message);
  expect(f.samples.at(-1)?.outputTokens).toBeUndefined();
  expect(f.samples.at(-1)?.ttftMs).toBe(800);
});

it("does not invent speed for one wire event or reuse a partial count as final usage", () => {
  const f = fixture();
  f.delta(900);
  f.stream.generated(); // A tool name and arguments in the same wire event.
  f.stream.recordUsage(85);
  expect(f.samples.at(-1)?.generationMs).toBeUndefined();
  f.delta(1900);
  f.stream.recordUsage(85);
  f.delta(2900);
  f.stream.end(f.message);
  expect(f.samples.at(-1)).toEqual({ ttftMs: 800, requestMs: 2800 });
});

it("starts each HTTP attempt afresh and ignores redacted placeholders", () => {
  const f = fixture();
  f.delta(900);
  f.at(20000);
  f.stream.startRequest();
  expect(f.samples.at(-1)).toEqual({});
  f.message.content = [{ type: "thinking", thinking: "[Reasoning redacted]", redacted: true }];
  f.at(20200, { type: "thinking_start", contentIndex: 0, partial: f.message });
  expect(f.samples.at(-1)).toEqual({});
  f.delta(20800);
  expect(f.samples.at(-1)).toEqual({ ttftMs: 800 });
});
