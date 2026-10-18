import { afterEach, expect, it, vi } from "vitest";
import {
  createAssistantMessageEventStream,
  emptyAssistant,
  normalizeContext,
  type TranscriptContext,
} from "zpi-ai";
import { ModelRuntime } from "zpi-coding-agent";
import { fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import * as mediaPolicy from "../../ai/src/utils/media-policy.ts";
import { completeSummarization } from "../src/core/compaction.ts";

const oversized = "a".repeat(40 * 1024 * 1024);
function context(): TranscriptContext {
  return normalizeContext({
    messages: [
      { role: "user", content: [{ type: "image", mimeType: "image/png", data: oversized }], timestamp: 0 },
      { role: "user", content: "current", timestamp: 1 },
    ],
  });
}
afterEach(() => vi.restoreAllMocks());
it.each([false, true])(
  "reports one session-scoped omission for a provider request (custom=%s)",
  async (custom) => {
    const onMediaProjection = vi.fn();
    const runtime = await ModelRuntime.create({ onMediaProjection });
    runtime.registerProvider("fake", {
      apiKey: "local",
      models: [{ ...fakeConfig("http://unused"), input: ["text", "image"] }],
      ...(custom
        ? ({
            streamSimple(model, transcript) {
              expect(JSON.stringify(transcript)).not.toContain(oversized);
              const events = createAssistantMessageEventStream();
              events.end(emptyAssistant(model));
              return events;
            },
          } satisfies Parameters<ModelRuntime["registerProvider"]>[1])
        : {}),
    });
    const projection = vi.spyOn(mediaPolicy, "projectContextForModelMediaPolicy");
    await runtime
      .streamSimple({ ...fakeModel("http://unused"), input: ["text", "image"] }, context(), {
        sessionId: "session-1",
        onPayload: () => {
          throw new Error("captured");
        },
      })
      .result();
    expect(projection).toHaveBeenCalledOnce();
    expect(onMediaProjection).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        omittedMediaCount: 1,
        retainedMediaCount: 0,
        projectedMediaBytes: 0,
        totalMediaBytes: oversized.length + 22,
        evictionFrontier: { messageIndex: 0, blockIndex: 0 },
      }),
      { sessionId: "session-1", provider: "fake", modelId: "fake" },
    );
  },
);
it("does not notify below budget and accepts an omitted diagnostics hook", async () => {
  const onMediaProjection = vi.fn();
  for (const hook of [onMediaProjection, undefined]) {
    const runtime = new ModelRuntime(undefined, { onMediaProjection: hook });
    runtime.registerProvider("fake", {
      models: [fakeConfig("")],
      streamSimple(model) {
        const events = createAssistantMessageEventStream();
        events.end(emptyAssistant(model));
        return events;
      },
    });
    await runtime
      .streamSimple(fakeModel(""), { messages: [{ role: "user", content: "small", timestamp: 0 }] })
      .result();
  }
  expect(onMediaProjection).not.toHaveBeenCalled();
});
it("reports a compact projection once despite a defensive injected-stream boundary, using the parent session ID", async () => {
  const onMediaProjection = vi.fn();
  const runtime = new ModelRuntime(undefined, { onMediaProjection });
  runtime.registerProvider("fake", {
    models: [{ ...fakeConfig(""), input: ["text", "image"] }],
    streamSimple(model) {
      const events = createAssistantMessageEventStream();
      events.end({ ...emptyAssistant(model), content: [{ type: "text", text: "summary" }] });
      return events;
    },
  });
  const model = { ...fakeModel(""), input: ["text", "image"] as ("text" | "image")[] };
  const result = await completeSummarization(
    model,
    context(),
    {
      sessionId: "summary-route",
      onMediaProjection: runtime.mediaProjectionObserver(model, "parent-session"),
    },
    (m, transcript, options) => runtime.streamSimple(m, transcript, options),
  );
  expect(result.stopReason).toBe("stop");
  expect(onMediaProjection).toHaveBeenCalledOnce();
  expect(onMediaProjection.mock.calls[0][1].sessionId).toBe("parent-session");
});
