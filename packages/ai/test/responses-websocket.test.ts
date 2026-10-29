import { createServer, type Server } from "node:http";
import { type AddressInfo, connect } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer } from "ws";
import { createAssistantMessageEventStream, emptyAssistant, normalizeContext, streamSimple } from "zpi-ai";
import { ResponsesSession } from "zpi-ai/api/responses-session";
import { AgentSession, ModelRuntime, SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import type { Message, Model, SimpleStreamOptions } from "../src/types.ts";

type Request = Record<string, unknown> & { input: unknown[] };
type Received = { body: Request; socket: WebSocket; authorization?: string };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
const user = (content: string): Message => ({ role: "user", content, timestamp: 1 });
const text = (value: string) => ({
  type: "message",
  id: "msg",
  role: "assistant",
  status: "completed",
  content: [{ type: "output_text", text: value, annotations: [] }],
});
function completed(id: string, output: unknown[] = [text("hello")]) {
  return {
    type: "response.completed",
    sequence_number: 1,
    response: {
      id,
      model: "fake",
      status: "completed",
      output,
      usage: {
        input_tokens: 10,
        output_tokens: output.length ? 2 : 0,
        total_tokens: 12,
        input_tokens_details: { cached_tokens: 0 },
      },
    },
  };
}
async function fixture(handle?: (request: Received, count: number) => void, rejectUpgrade = false) {
  const requests: Received[] = [];
  let httpCalls = 0;
  const server: Server = createServer((_request, response) => {
    httpCalls++;
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.end(`data: ${JSON.stringify(completed("http"))}\n\n`);
  });
  const sockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (request, socket, head) => {
    if (rejectUpgrade) {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (raw) => {
        const entry = {
          body: JSON.parse(raw.toString()) as Request,
          socket: ws,
          authorization: request.headers.authorization,
        };
        requests.push(entry);
        if (handle) handle(entry, requests.length);
        else
          ws.send(
            JSON.stringify(
              completed(`resp_${requests.length}`, entry.body.generate === false ? [] : undefined),
            ),
          );
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>((resolve) => sockets.close(() => resolve()));
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const model: Model = { ...fakeModel(baseUrl), api: "openai-responses" };
  const session = new ResponsesSession();
  cleanups.push(() => session.dispose());
  const run = (messages: Message[], options: SimpleStreamOptions = {}, target = model) =>
    streamSimple(target, normalizeContext({ messages }), {
      apiKey: "local-test-key",
      sessionId: "conversation",
      responsesSession: session,
      maxRetries: 0,
      ...options,
    }).result();
  return { run, requests, session, model, httpCalls: () => httpCalls };
}

it.each([false, true])(
  "warms up and continues the same authenticated socket (subscription=%s)",
  async (subscription) => {
    const f = await fixture();
    const model = { ...f.model, ...(subscription ? { auth: "chatgpt" as const } : {}) };
    const base = [user("earlier")];
    expect((await f.run(base, { responsesWarmup: true }, model)).stopReason).toBe("stop");
    const response = await f.run([...base, user("next")], {}, model);
    expect(response.content).toMatchObject([{ type: "text", text: "hello" }]);
    expect(f.requests[0].body).toMatchObject({ type: "response.create", generate: false, store: false });
    expect(f.requests[0].body.stream).toBeUndefined();
    expect(f.requests[1].body).toMatchObject({
      previous_response_id: "resp_1",
      input: [{ role: "user", content: "next" }],
    });
    expect(f.requests[1].socket).toBe(f.requests[0].socket);
    expect(f.requests[0].authorization).toBe("Bearer local-test-key");
    expect(f.httpCalls()).toBe(0);
  },
);

it("continues tool calls with just their results while retaining encrypted reasoning", async () => {
  const reason = { type: "reasoning", id: "rs", summary: [], encrypted_content: "local-encrypted" };
  const call = {
    type: "function_call",
    id: "fc",
    call_id: "call_1",
    name: "read",
    arguments: '{ "path": "README.md" }',
    status: "completed",
  };
  const f = await fixture(({ socket }, count) =>
    socket.send(JSON.stringify(completed(`resp_${count}`, count === 1 ? [reason, call] : undefined))),
  );
  const messages = [user("read it")];
  const first = await f.run(messages);
  expect(first.stopReason).toBe("toolUse");
  await f.run([
    ...messages,
    first,
    {
      role: "toolResult",
      toolCallId: "call_1|fc",
      toolName: "read",
      content: [{ type: "text", text: "file contents" }],
      isError: false,
      timestamp: 2,
    },
  ]);
  expect(f.requests[1].body).toMatchObject({
    previous_response_id: "resp_1",
    input: [{ type: "function_call_output", call_id: "call_1", output: "file contents" }],
  });
});

it("keeps assistant text and phases out of incremental user turns", async () => {
  const f = await fixture(({ socket }, count) =>
    socket.send(JSON.stringify(completed(`resp_${count}`, [{ ...text("hello"), phase: "final_answer" }]))),
  );
  const first = await f.run([user("first")]);
  await f.run([user("first"), first, user("second")]);
  expect(f.requests[1].body.input).toEqual([{ role: "user", content: "second" }]);
  expect(f.requests[1].body.previous_response_id).toBe("resp_1");
});

it.each(["compaction", "instructions", "reasoning"])("replays full input when %s changes", async (change) => {
  const f = await fixture();
  const first = await f.run([user("first")]);
  const messages =
    change === "compaction"
      ? [user("compacted summary"), user("second")]
      : [user("first"), first, user("second")];
  const result = await f.run(messages, {
    onPayload: (payload) => ({
      ...(payload as object),
      ...(change === "instructions" ? { instructions: "new instructions" } : {}),
      ...(change === "reasoning" ? { reasoning: { effort: "high" } } : {}),
    }),
  });
  expect(result.stopReason).toBe("stop");
  expect(f.requests[1].body.previous_response_id).toBeUndefined();
  expect(f.requests[1].body.input.length).toBe(messages.length);
});

it("replays all intervening domestic-model messages after switching back to GPT", async () => {
  const f = await fixture();
  const first = await f.run([user("first")]);
  const domestic = {
    ...emptyAssistant({ ...f.model, provider: "domestic", id: "glm" }),
    content: [{ type: "text" as const, text: "domestic answer" }],
  };
  const history = [user("first"), first, user("domestic question"), domestic, user("back to GPT")];
  const changedModel = { ...f.model, id: "another-gpt" };
  await f.run(history, {}, changedModel);
  await f.run(history);
  expect(f.requests[2].body.previous_response_id).toBeUndefined();
  expect(f.requests[2].body.input).toContainEqual({ role: "assistant", content: "domestic answer" });
  expect(f.requests[2].body.input.at(-1)).toEqual({ role: "user", content: "back to GPT" });
  expect(f.requests[2].socket).not.toBe(f.requests[0].socket);
});

it("opens a fresh socket and chain after credentials change", async () => {
  const f = await fixture();
  const first = await f.run([user("first")]);
  await f.run([user("first"), first, user("next")], { apiKey: "replacement-key" });
  expect(f.requests[1].authorization).toBe("Bearer replacement-key");
  expect(f.requests[1].body.previous_response_id).toBeUndefined();
  expect(f.requests[1].socket).not.toBe(f.requests[0].socket);
});

it("recovers an evicted previous response by sending full input once", async () => {
  const f = await fixture(({ body, socket }, count) => {
    socket.send(
      JSON.stringify(
        body.previous_response_id
          ? {
              type: "error",
              status: 400,
              error: {
                code: "previous_response_not_found",
                message: "evicted",
                type: "invalid_request_error",
              },
            }
          : completed(`resp_${count}`),
      ),
    );
  });
  const first = await f.run([user("first")]);
  expect((await f.run([user("first"), first, user("next")])).stopReason).toBe("stop");
  expect(f.requests[1].body.previous_response_id).toBe("resp_1");
  expect(f.requests[2].body.previous_response_id).toBeUndefined();
  expect(f.requests[2].body.input).toHaveLength(3);
  expect(f.httpCalls()).toBe(0);
});

it("reconnects with full history after the idle socket closes", async () => {
  const f = await fixture();
  const first = await f.run([user("first")]);
  f.requests[0].socket.close();
  await vi.waitFor(() => expect(f.requests[0].socket.readyState).toBe(WebSocket.CLOSED));
  await f.run([user("first"), first, user("next")]);
  expect(f.requests[1].body.previous_response_id).toBeUndefined();
  expect(f.requests[1].body.input).toHaveLength(3);
});

it("falls back to HTTP and avoids retrying a rejected upgrade every tool round", async () => {
  const f = await fixture(undefined, true);
  expect((await f.run([user("first")])).responseId).toBe("http");
  expect((await f.run([user("second")])).responseId).toBe("http");
  expect(f.httpCalls()).toBe(2);
  expect(f.requests).toHaveLength(0);
});

it("never falls back to HTTP during warmup", async () => {
  const f = await fixture(undefined, true);
  await f.run([], { responsesWarmup: true });
  expect(f.httpCalls()).toBe(0);
});

it("does not silently replay a response after receiving partial output", async () => {
  const f = await fixture(({ socket }) => {
    socket.send(
      JSON.stringify({
        type: "response.output_text.delta",
        item_id: "msg",
        content_index: 0,
        delta: "partial",
        sequence_number: 0,
      }),
    );
    socket.close();
  });
  const response = await f.run([user("first")]);
  expect(response.stopReason).toBe("error");
  expect(response.content).toMatchObject([{ type: "text", text: "partial" }]);
  expect(f.httpCalls()).toBe(0);
});

it("surfaces request and usage errors without a second HTTP request", async () => {
  const f = await fixture(({ socket }) =>
    socket.send(
      JSON.stringify({
        type: "error",
        status: 429,
        error: { code: "rate_limit_exceeded", message: "quota exhausted", type: "rate_limit_error" },
      }),
    ),
  );
  const response = await f.run([user("first")]);
  expect(response.stopReason).toBe("error");
  expect(response.errorMessage).toContain("quota exhausted");
  expect(f.httpCalls()).toBe(0);
});

it("aborts stalled generation and closes the connection without HTTP replay", async () => {
  const f = await fixture(() => {});
  const controller = new AbortController();
  const pending = f.run([user("first")], { signal: controller.signal });
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  controller.abort();
  expect((await pending).stopReason).toBe("aborted");
  expect(f.httpCalls()).toBe(0);
});

it("isolates two conversations even when they use the same credentials", async () => {
  const f = await fixture();
  const other = new ResponsesSession();
  cleanups.push(() => other.dispose());
  await f.run([user("first")]);
  await f.run([user("other")], { responsesSession: other });
  expect(f.requests[1].socket).not.toBe(f.requests[0].socket);
  expect(f.requests[1].body.previous_response_id).toBeUndefined();
});

it("supports GPT → domestic model → GPT in a real agent session, then resumes incrementally", async () => {
  const f = await fixture();
  const runtime = new ModelRuntime();
  const { provider, baseUrl, ...definition } = f.model;
  runtime.registerProvider(provider, { baseUrl, apiKey: "local-key", models: [definition] });
  runtime.registerProvider("domestic", {
    models: [{ ...definition, id: "glm", api: "openai-completions" }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const result = emptyAssistant(model);
      result.content = [{ type: "text", text: "domestic answer" }];
      // A custom provider avoids any external inference dependency in this integration test.
      stream.end(result);
      return stream;
    },
  });
  vi.spyOn(runtime, "canUseResponsesSession").mockImplementation((model) => model.provider === provider);
  const manager = SessionManager.inMemory();
  const session = new AgentSession(f.model, runtime, manager, [], [], "", "off");
  cleanups.push(() => session.dispose());
  await session.prompt("first GPT question");
  const originalSocket = f.requests[0].socket;
  const domestic = runtime.getModel("domestic", "glm");
  if (!domestic) throw new Error("Missing local domestic model");
  await session.setModel(domestic);
  await session.prompt("domestic question one");
  await session.prompt("domestic question two");
  await session.setModel(f.model);
  await session.prompt("back to GPT");
  const warmup = f.requests.findLast((request) => request.body.generate === false);
  expect(warmup?.socket).not.toBe(originalSocket);
  expect(warmup?.body.previous_response_id).toBeUndefined();
  expect(
    warmup?.body.input.filter((item) => (item as { content?: string }).content === "domestic answer"),
  ).toHaveLength(2);
  expect(warmup?.body.input).toContainEqual({ role: "user", content: "domestic question two" });
  await session.prompt("another GPT question");
  expect(f.requests.at(-1)?.body.input).toEqual([{ role: "user", content: "another GPT question" }]);
  expect(f.requests.at(-1)?.body.previous_response_id).toBeDefined();
  expect(
    manager.buildSessionContext().messages.filter((message) => message.role === "assistant"),
  ).toHaveLength(5);
  expect(f.httpCalls()).toBe(0);
});

it("routes WebSocket upgrades through the host's resolved HTTP CONNECT proxy", async () => {
  const f = await fixture();
  let connections = 0;
  const proxy = createServer();
  proxy.on("connect", (request, client, head) => {
    connections++;
    const target = new URL(`http://${request.url}`);
    const upstream = connect(Number(target.port), target.hostname, () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      upstream.write(head);
      client.pipe(upstream).pipe(client);
    });
    upstream.on("error", () => client.destroy());
    client.on("close", () => upstream.destroy());
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  cleanups.push(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
  const proxied = new ResponsesSession({
    resolveProxy: async () => `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
  });
  cleanups.push(() => proxied.dispose());
  const result = await f.run([user("proxied")], { responsesSession: proxied });
  expect(result.stopReason).toBe("stop");
  expect(connections).toBe(1);
  expect(f.httpCalls()).toBe(0);
});

it("does not retry generation when an onResponse observer fails", async () => {
  const f = await fixture();
  const result = await f.run([user("first")], {
    onResponse: () => {
      throw new Error("observer failed");
    },
  });
  expect(result.stopReason).toBe("error");
  expect(result.errorMessage).toContain("observer failed");
  expect(f.httpCalls()).toBe(0);
});

it("keeps a timed-out warmup from delaying the next request with another WebSocket attempt", async () => {
  const f = await fixture(() => {});
  const controller = new AbortController();
  const warming = f.run([], { responsesWarmup: true, signal: controller.signal });
  await vi.waitFor(() => expect(f.requests).toHaveLength(1));
  controller.abort();
  await warming;
  expect((await f.run([user("continue over HTTP")])).responseId).toBe("http");
  expect(f.requests).toHaveLength(1);
  expect(f.httpCalls()).toBe(1);
});
