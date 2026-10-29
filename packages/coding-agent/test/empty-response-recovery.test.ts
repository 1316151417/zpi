import { expect, it } from "vitest";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";

it.each([false, true])("retries an empty completed response only once, then success=%s", async (recovers) => {
  let requests = 0;
  const runtime = new ModelRuntime((async () => {
    requests++;
    const output =
      recovers && requests === 2
        ? [
            {
              type: "message",
              id: "msg",
              role: "assistant",
              status: "completed",
              content: [{ type: "output_text", text: "recovered", annotations: [] }],
            },
          ]
        : [];
    return new Response(
      `data: ${JSON.stringify({
        type: "response.completed",
        response: {
          id: `resp_${requests}`,
          model: "fake",
          status: "completed",
          output,
          usage: null,
        },
      })}\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as typeof fetch);
  runtime.registerProvider("fake", {
    baseUrl: "http://local/v1",
    apiKey: "key",
    models: [{ ...fakeConfig(""), api: "openai-responses" }],
  });
  const { session } = await createAgentSession({
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(),
    resourceLoader: new StaticResourceLoader(),
    settingsManager: SettingsManager.inMemory({
      retry: { baseDelayMs: 0, maxRetries: 10 },
      compaction: { enabled: false },
    }),
    noTools: "all",
  });
  try {
    await session.prompt("answer");
    expect(requests).toBe(2);
    expect(session.messages.at(-1)).toMatchObject(
      recovers
        ? { stopReason: "stop", content: [{ text: "recovered" }] }
        : { stopReason: "error", errorDetails: { code: "EMPTY_MODEL_RESPONSE", retryable: true } },
    );
    expect(session.isIdle).toBe(true);
  } finally {
    session.dispose();
  }
});
