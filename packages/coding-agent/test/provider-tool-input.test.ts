import { access } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

it("does not write a file from truncated Anthropic arguments even if the provider claims tool_use", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create({
    fetch: async () =>
      new Response(
        [
          {
            type: "message_start",
            message: { id: "m", model: "fake", usage: { input_tokens: 10, output_tokens: 0 } },
          },
          {
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: "w", name: "write", input: {} },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: '{"path":"broken.txt","content":"TRUNCATED' },
          },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 128 } },
          { type: "message_stop" },
        ]
          .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
          .join(""),
        { headers: { "content-type": "text/event-stream" } },
      ),
  });
  runtime.registerProvider("fake", {
    apiKey: "test",
    baseUrl: "https://example.invalid/v1",
    api: "anthropic-messages",
    models: [{ ...fakeConfig(""), api: "anthropic-messages" }],
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    homeDir: join(cwd, "home"),
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } }),
    resourceLoader: new StaticResourceLoader(),
  });
  let executions = 0;
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") executions++;
  });
  try {
    await session.prompt("Write the requested file");
    expect(executions).toBe(0);
    await expect(access(join(cwd, "broken.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(session.messages.at(-1)).toMatchObject({ role: "assistant", stopReason: "error", content: [] });
    expect(session.isIdle).toBe(true);
  } finally {
    session.dispose();
  }
});
