import { emptyAssistant, normalizeContext } from "ZPI-ai";
import { streamSimple } from "ZPI-ai/api/openai-completions";
import { afterEach, describe, expect, it } from "vitest";
import { chunk, deferred, done, fakeModel, fakeServer, send } from "../../../tests/fake-server.ts";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((f) => f()));
});
async function server(handler: Parameters<typeof fakeServer>[0]) {
  const s = await fakeServer(handler);
  cleanup.push(s.close);
  return s;
}
describe("OpenAI streaming contract", () => {
  it("streams before release, handles split UTF-8, interleaved calls and usage tail", async () => {
    const release = deferred();
    const first = deferred<string>();
    const s = await server(async (_, res) => {
      send(res, chunk({ reasoning_content: "计划\n最新" }));
      const bytes = Buffer.from(`data: ${JSON.stringify(chunk({ content: "你好 🌍" }))}\n\n`);
      const split = bytes.indexOf(Buffer.from("你")) + 1;
      res.write(bytes.subarray(0, split));
      res.write(bytes.subarray(split));
      await release.promise;
      send(
        res,
        chunk({
          tool_calls: [
            { index: 0, id: "a", type: "function", function: { name: "one", arguments: '{"x":' } },
            { index: 1, id: "b", type: "function", function: { name: "two", arguments: '{"y":' } },
          ],
        }),
      );
      send(
        res,
        chunk({
          tool_calls: [
            { index: 1, function: { arguments: "2}" } },
            { index: 0, function: { arguments: "1}" } },
          ],
        }),
      );
      send(res, chunk({}, "tool_calls"));
      send(res, {
        ...chunk({}),
        choices: [],
        usage: {
          prompt_tokens: 10,
          completion_tokens: 5,
          total_tokens: 15,
          prompt_tokens_details: { cached_tokens: 2 },
          completion_tokens_details: { reasoning_tokens: 3 },
        },
      });
      res.end("data: [DONE]\n\n");
    });
    const stream = streamSimple(fakeModel(s.url), normalizeContext({ messages: [] }), { apiKey: "local" });
    const types: string[] = [];
    const consume = (async () => {
      for await (const e of stream) {
        types.push(e.type);
        if (e.type === "text_delta") first.resolve(e.delta);
      }
    })();
    expect(await first.promise).toBe("你好 🌍");
    expect(types).not.toContain("done");
    release.resolve();
    await consume;
    const result = await stream.result();
    expect(result.content.filter((c) => c.type === "toolCall").map((c) => c.arguments)).toEqual([
      { x: 1 },
      { y: 2 },
    ]);
    expect(result.usage).toMatchObject({ input: 8, cacheRead: 2, output: 5, reasoning: 3, totalTokens: 15 });
    expect(types.at(-1)).toBe("done");
  });
  it.each(["length", "stop"])("maps %s", async (reason) => {
    const s = await server((_, r) => {
      send(r, chunk({ content: "hello" }));
      done(r, reason);
    });
    const result = await streamSimple(fakeModel(s.url), normalizeContext({ messages: [] }), {
      apiKey: "local",
    }).result();
    expect(result.stopReason).toBe(reason);
  });

  it("abort finishes result while waiting for bytes", async () => {
    const ready = deferred();
    const s = await server((_, r) => {
      send(r, chunk({ content: "visible" }));
      ready.resolve();
    });
    const controller = new AbortController();
    const stream = streamSimple(fakeModel(s.url), normalizeContext({ messages: [] }), {
      apiKey: "local",
      signal: controller.signal,
    });
    await ready.promise;
    controller.abort();
    expect((await stream.result()).stopReason).toBe("aborted");
  });
  it("preserves tool pairing and sends image result as a subsequent user message", async () => {
    const s = await server((_, r) => done(r));
    await streamSimple(
      fakeModel(s.url),
      normalizeContext({
        messages: [
          {
            ...emptyAssistant(fakeModel(s.url)),
            stopReason: "toolUse",
            content: [{ type: "toolCall", id: "c", name: "shot", arguments: {} }],
          },
          {
            role: "toolResult",
            toolCallId: "c",
            toolName: "shot",
            content: [{ type: "image", data: "aA==", mimeType: "image/png" }],
            isError: false,
            timestamp: 0,
          },
        ],
      }),
      { apiKey: "local" },
    ).result();
    const messages = s.requests[0].messages as unknown as { role: string; tool_call_id?: string }[];
    expect(messages.map((m) => m.role)).toEqual(["assistant", "tool", "user"]);
    expect(messages[1].tool_call_id).toBe("c");
  });
});

it("maxRetries: 0 disables provider retries", async () => {
  const s = await server((_, r) => {
    r.writeHead(429, { "content-type": "application/json" });
    r.end(JSON.stringify({ error: { message: "quota exhausted" } }));
  });
  const stream = streamSimple(fakeModel(s.url), normalizeContext({ messages: [] }), {
    apiKey: "local",
    maxRetries: 0,
  });
  const result = await stream.result();
  expect(result.stopReason).toBe("error");
  expect(s.requests).toHaveLength(1);
});

it("model switches and retries replay only valid assistant messages without changing history", async () => {
  const s = await server((_, r) => {
    send(r, chunk({ content: "recovered" }));
    done(r);
  });
  const source = { ...fakeModel(s.url), provider: "zhipu", id: "glm" };
  const target = {
    ...fakeModel(s.url),
    provider: "deepseek",
    id: "deepseek",
    compat: { requiresReasoningContentOnAssistantMessages: true },
  };
  const assistant = emptyAssistant(source);
  const context = normalizeContext({
    messages: [
      { role: "user", content: "first", timestamp: 0 },
      {
        ...assistant,
        content: [
          { type: "thinking", thinking: "plan" },
          { type: "text", text: "answer" },
        ],
      },
      {
        ...assistant,
        content: [
          { type: "thinking", thinking: "read file" },
          { type: "toolCall", id: "call", name: "read", arguments: { path: "README.md" } },
        ],
        stopReason: "toolUse",
      },
      {
        role: "toolResult",
        toolCallId: "call",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 0,
      },
      { ...assistant, stopReason: "aborted", content: [] },
      {
        ...assistant,
        stopReason: "aborted",
        content: [
          { type: "thinking", thinking: "partial thought" },
          { type: "text", text: "partial reply" },
        ],
      },
      { ...assistant, stopReason: "error", errorMessage: "400 Invalid assistant message", content: [] },
      { ...assistant, content: [{ type: "text", text: "  " }] },
      { ...assistant, content: [{ type: "thinking", thinking: "reasoning only" }] },
      {
        ...assistant,
        content: [{ type: "thinking", thinking: "opaque", redacted: true, thinkingSignature: "secret" }],
      },
      { role: "user", content: "continue", timestamp: 1 },
    ],
  });
  const original = structuredClone(context);
  for (const model of [target, source]) {
    expect((await streamSimple(model, context, { apiKey: "local" }).result()).stopReason).toBe("stop");
    const rows = s.requests.at(-1)?.messages as unknown as {
      role: string;
      content: string | null;
      tool_calls?: { id: string }[];
      tool_call_id?: string;
      reasoning_content?: string;
    }[];
    const replies = rows.filter((row) => row.role === "assistant");
    expect(replies.every((row) => Boolean(row.content || row.tool_calls?.length))).toBe(true);
    expect(replies.map((row) => row.content)).toEqual(
      model === target ? ["plan\nanswer", "read file", "reasoning only"] : ["answer", null],
    );
    expect(replies[1].tool_calls?.[0].id).toBe("call");
    expect(rows.find((row) => row.role === "tool")?.tool_call_id).toBe("call");
    expect(JSON.stringify(rows)).not.toMatch(/partial thought|partial reply|opaque|secret/);
    if (model === target) expect(replies.every((row) => row.reasoning_content === "")).toBe(true);
  }
  expect(context).toEqual(original);
});
