import { expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  emptyAssistant,
  normalizeContext,
  type TranscriptContext,
} from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { completeSummarization } from "../src/core/compaction.ts";

it.each([
  ["image too large", 2, true],
  ["context length exceeded", 2, false],
  ["413 Failed to buffer the request body: length limit exceeded", 1, false],
  ["payload too large", 1, false],
] as const)("only retries recognized compact failures: %s", async (message, count, stripsMedia) => {
  const model = { ...fakeModel(""), input: ["text", "image"] as ("text" | "image")[] };
  const context = normalizeContext({
    messages: [
      {
        role: "user",
        timestamp: 0,
        content: [
          { type: "text", text: "x".repeat(1024) },
          { type: "image", data: "a", mimeType: "image/png" },
        ],
      },
    ],
  });
  const original = structuredClone(context);
  const requests: TranscriptContext[] = [];
  await completeSummarization(model, context, {}, (_model, request) => {
    requests.push(request);
    const response = emptyAssistant(model);
    if (requests.length === 1) {
      response.stopReason = "error";
      response.errorMessage = message;
    } else response.content = [{ type: "text", text: "summary" }];
    const events = createAssistantMessageEventStream();
    events.end(response);
    return events;
  });
  expect(requests).toHaveLength(count);
  if (count === 2) {
    expect(JSON.stringify(requests[1]).includes('"type":"image"')).toBe(!stripsMedia);
    if (stripsMedia) expect(JSON.stringify(requests[1])).toContain("[image]");
    else expect(JSON.stringify(requests[1]).length).toBeLessThan(JSON.stringify(requests[0]).length);
  }
  expect(context).toEqual(original);
});
