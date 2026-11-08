import type { ServerResponse } from "node:http";
import type { JsonObject } from "@zpi-dev/ai";
import {
  createAgentSession,
  ModelRuntime,
  runModelExchange,
  runSessionInput,
  SessionManager,
  SettingsManager,
  StaticResourceLoader,
} from "@zpi-dev/coding-agent";
import { afterEach, expect, test } from "vitest";
import { chunk, deferred, done, fakeConfig, fakeServer, send } from "../../../tests/fake-server.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture(handler: (body: JsonObject, response: ServerResponse, index: number) => void) {
  const server = await fakeServer(handler);
  cleanup.push(server.close);
  const runtime = new ModelRuntime();
  runtime.registerProvider("fake", { baseUrl: server.url, apiKey: "fake", models: [fakeConfig(server.url)] });
  const model = runtime.getModel("fake", "fake");
  if (!model) throw new Error("Missing fake model");
  return { runtime, model };
}

async function ownedSession(f: Awaited<ReturnType<typeof fixture>>) {
  const manager = SessionManager.inMemory("/tmp/zpi-host-run");
  const { session } = await createAgentSession({
    modelRuntime: f.runtime,
    model: f.model,
    sessionManager: manager,
    settingsManager: SettingsManager.inMemory({ retry: { enabled: false } }),
    resourceLoader: new StaticResourceLoader(),
    noTools: "all",
  });
  return { session, manager };
}

test("runSessionInput executes a prompt, flushes entries and keeps session ownership", async () => {
  const f = await fixture((_body, response) => {
    send(response, chunk({ content: "完成" }));
    done(response);
  });
  const { session, manager } = await ownedSession(f);
  await runSessionInput({
    session,
    sessionManager: manager,
    input: { parsed: { kind: "prompt", text: "你好" }, context: {} },
  });
  const last = session.messages.findLast((message) => message.role === "assistant");
  expect(last?.role).toBe("assistant");
  expect(manager.getEntries().some((entry) => entry.type === "message")).toBe(true);
  session.dispose();
});

test("runSessionInput rethrows provider failures after flushing persistence", async () => {
  const f = await fixture(() => {
    throw new Error("provider down");
  });
  const { session, manager } = await ownedSession(f);
  await expect(
    runSessionInput({
      session,
      sessionManager: manager,
      input: { parsed: { kind: "prompt", text: "你好" }, context: {} },
    }),
  ).rejects.toThrow();
  session.dispose();
});

test("runSessionInput aborts an in-flight exchange through the session", async () => {
  const hold = deferred();
  const f = await fixture(() => hold.promise);
  const { session, manager } = await ownedSession(f);
  const controller = new AbortController();
  const pending = runSessionInput({
    session,
    sessionManager: manager,
    input: { parsed: { kind: "prompt", text: "你好" }, context: {} },
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  controller.abort(new Error("user stop"));
  await expect(pending).rejects.toThrow();
  hold.resolve();
  session.dispose();
});

test("runModelExchange returns the final assistant message from an isolated session", async () => {
  const f = await fixture((_body, response) => {
    send(response, chunk({ content: '{"session_title":"演示标题"}' }));
    done(response);
  });
  const { message, error } = await runModelExchange({
    runtime: f.runtime,
    model: f.model,
    systemPrompt: "Return only JSON.",
    prompt: "你好",
    requestOptions: { maxTokens: 5000, maxRetries: 0 },
  });
  expect(error).toBeUndefined();
  expect(message?.stopReason).toBe("stop");
  expect(message?.content.some((part) => part.type === "text" && part.text.includes("演示标题"))).toBe(true);
});

test("runModelExchange reports hallucinated tool calls without looping", async () => {
  const f = await fixture((_body, response) => {
    send(
      response,
      chunk({
        tool_calls: [
          { index: 0, id: "call-1", type: "function", function: { name: "read", arguments: "{}" } },
        ],
      }),
    );
    done(response, "tool_calls");
  });
  const { message, error } = await runModelExchange({
    runtime: f.runtime,
    model: f.model,
    systemPrompt: "x",
    prompt: "你好",
    requestOptions: { maxRetries: 0 },
  });
  expect(message?.stopReason).toBe("toolUse");
  expect(error).toBeInstanceOf(Error);
});

test("runModelExchange surfaces provider failures as classified errors with the message", async () => {
  const f = await fixture((_body, response) => {
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: { message: "authentication failed" } }));
  });
  const { message, error } = await runModelExchange({
    runtime: f.runtime,
    model: f.model,
    systemPrompt: "x",
    prompt: "你好",
    requestOptions: { maxRetries: 0 },
  });
  expect(message?.stopReason).toBe("error");
  expect(error?.message).toContain("authentication failed");
});

test("runModelExchange rejects a pre-aborted signal without contacting the provider", async () => {
  let called = false;
  const f = await fixture(() => {
    called = true;
  });
  const controller = new AbortController();
  controller.abort();
  await expect(
    runModelExchange({
      runtime: f.runtime,
      model: f.model,
      systemPrompt: "x",
      prompt: "y",
      signal: controller.signal,
    }),
  ).rejects.toThrow();
  expect(called).toBe(false);
});
