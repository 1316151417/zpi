import { afterEach, expect, it, vi } from "vitest";
import { normalizeContext, type SimpleStreamOptions, streamSimple, type TranscriptContext } from "zpi-ai";
import { fakeModel } from "../../../tests/fake-server.ts";
import { streamSimple as anthropic } from "../src/api/anthropic-messages.ts";
import { stream as completions } from "../src/api/openai-completions.ts";
import { streamSimple as responses } from "../src/api/openai-responses.ts";
import * as mediaPolicy from "../src/utils/media-policy.ts";

const model = { ...fakeModel("http://unused/v1"), input: ["text", "image"] as ("text" | "image")[] };
const oversized = "a".repeat(40 * 1024 * 1024);
const transports = [
  {
    name: "common stream wrapper",
    run: (context: TranscriptContext, options: SimpleStreamOptions) => streamSimple(model, context, options),
  },
  {
    name: "direct Anthropic",
    run: (context: TranscriptContext, options: SimpleStreamOptions) =>
      anthropic({ ...model, api: "anthropic-messages" }, context, options),
  },
  {
    name: "direct Completions",
    run: (context: TranscriptContext, options: SimpleStreamOptions) => completions(model, context, options),
  },
  {
    name: "direct Responses",
    run: (context: TranscriptContext, options: SimpleStreamOptions) =>
      responses({ ...model, api: "openai-responses" }, context, options),
  },
];
afterEach(() => vi.restoreAllMocks());
it.each(transports)("projects and reports once at the request boundary: $name", async ({ run }) => {
  const context = normalizeContext({
    messages: [
      { role: "user", timestamp: 0, content: [{ type: "image", data: oversized, mimeType: "image/png" }] },
      { role: "user", timestamp: 1, content: "current prompt" },
    ],
  });
  const project = vi.spyOn(mediaPolicy, "projectContextForModelMediaPolicy");
  const onMediaProjection = vi.fn();
  const onPayload = vi.fn(() => {
    throw new Error("captured");
  });
  await run(context, { apiKey: "local", onMediaProjection, onPayload }).result();
  expect(project).toHaveBeenCalledOnce();
  expect(onPayload).toHaveBeenCalledOnce();
  expect(onMediaProjection).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ omittedMediaCount: 1, evictionFrontier: { messageIndex: 0, blockIndex: 0 } }),
  );
  expect(JSON.stringify(onPayload.mock.calls[0])).not.toContain(oversized);
});
