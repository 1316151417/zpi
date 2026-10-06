import { SessionManager } from "ZPI-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, idle, setup } from "./helpers/session-fixture.ts";

it("title is independent, snapshot-bound, once-only and preserves the complete first message", async () => {
  const gate = deferred();
  const { host, settings, server, dir, cwd } = await setup(async (_, res) => {
    await gate.promise;
    if (!res.destroyed) {
      send(res, chunk({ content: '{"session_title":"完整生成的长标题，保留全部内容"}' }));
      done(res);
    }
  });
  const record = host.createSession(null),
    text = "这是完整用户消息，超过十个字，绝对不截断消息原文。";
  await host.startRun({ sessionId: record.id, text });
  await idle(host, record.id);
  expect(host.getSessionSnapshot(record.id).view.runs[0].userMessage).toBe(text);
  expect(server.titleRequests).toHaveLength(1);
  expect(server.titleRequests[0]).toMatchObject({
    model: "fake",
    max_tokens: 256,
    response_format: { type: "json_schema" },
  });
  expect(server.titleRequests[0].tools).toBeUndefined();
  expect(server.titleRequests[0].messages as unknown[]).toHaveLength(2);
  const changed = settings.snapshot("custom");
  settings.saveProvider({ ...changed, baseUrl: "http://127.0.0.1:1/v1" });
  gate.resolve();
  await expect.poll(() => host.listRecentSessions()[0].title).toBe("完整生成的长标题，保留全部内容");
  const log = await readFile(join(dir, "agent", "sessions", "_unassigned", `${record.id}.jsonl`), "utf8");
  expect(log).not.toContain("ZPI_SESSION_TITLE");
  expect(
    SessionManager.open(join(dir, "agent", "sessions", "_unassigned", `${record.id}.jsonl`))
      .buildSessionContext()
      .messages.some((m) => m.role === "user" && m.content === text),
  ).toBe(true);
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined, []);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.listRecentSessions()[0].title).toBe("完整生成的长标题，保留全部内容");
  settings.saveProvider({ ...changed, baseUrl: server.url });
  await reopened.startRun({ sessionId: record.id, text: "重启后继续会话" });
  await idle(reopened, record.id);
  expect(server.titleRequests).toHaveLength(1);
});

it("manual rename and deletion win over late title responses; title failure is not retried", async () => {
  const gate = deferred();
  const { host, server } = await setup(async (_, res) => {
    await gate.promise;
    if (!res.destroyed) {
      send(res, chunk({ content: '{"session_title":"晚到标题"}' }));
      done(res);
    }
  });
  const a = host.createSession(null),
    b = host.createSession(null);
  await host.startRun({ sessionId: a.id, text: "first A" });
  await idle(host, a.id);
  await host.startRun({ sessionId: b.id, text: "first B" });
  await idle(host, b.id);
  host.renameSession(a.id, "用户手动标题");
  await host.deleteSession(b.id);
  gate.resolve();
  await new Promise((r) => setTimeout(r, 30));
  expect(host.listRecentSessions().map((r) => r.title)).toEqual(["用户手动标题"]);
  await host.startRun({ sessionId: a.id, text: "second A" });
  await idle(host, a.id);
  expect(server.titleRequests).toHaveLength(2);
  const failed = await setup((_, res) => {
    send(res, chunk({ content: '{"session_title":false}' }));
    done(res);
  });
  const c = failed.host.createSession(null);
  await failed.host.startRun({ sessionId: c.id, text: "临时标题" });
  await idle(failed.host, c.id);
  await failed.host.startRun({ sessionId: c.id, text: "再次发送" });
  await idle(failed.host, c.id);
  expect(failed.server.titleRequests).toHaveLength(1);
  expect(failed.host.listRecentSessions()[0].title).toBe("临时标题");
});

it("generates a Responses title using an available effort and the portable structured-output preference", async () => {
  const { ModelRuntime } = await import("ZPI-coding-agent");
  const { generateSessionTitle } = await import("../src/main/session-title.ts");
  let payload: Record<string, unknown> = {};
  const runtime = await ModelRuntime.create({
    fetch: (async (_url, init) => {
      payload = JSON.parse(String(init?.body));
      const item = {
        type: "message",
        id: "msg_title",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: '{"session_title":"ChatGPT 标题"}', annotations: [] }],
      };
      return new Response(
        `data: ${JSON.stringify({ type: "response.output_item.done", item })}\n\ndata: ${JSON.stringify({ type: "response.completed", response: { id: "resp_title", model: "reasoning", status: "completed", output: [item] } })}\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch,
  });
  runtime.registerProvider("oauth", {
    baseUrl: "https://api.openai.com/v1",
    apiKey: "secret",
    models: [
      {
        id: "reasoning",
        name: "Reasoning",
        api: "openai-responses",
        auth: "chatgpt",
        input: ["text"],
        reasoning: true,
        contextWindow: 100000,
        maxTokens: 10000,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        compat: { supportsReasoningEffort: true, structuredOutput: "json_schema" },
        thinkingLevelMap: { off: null, minimal: null, low: "low", max: "xhigh" },
      },
    ],
  });
  const model = runtime.getModel("oauth", "reasoning");
  if (!model) throw new Error("Missing model");
  expect(await generateSessionTitle(runtime, model, "first turn", [], new AbortController().signal)).toBe(
    "ChatGPT 标题",
  );
  expect(payload).toMatchObject({
    store: false,
    stream: true,
    reasoning: { effort: "low" },
    text: { format: { type: "json_schema", name: "session_title", strict: true } },
  });
  expect(payload).not.toHaveProperty("max_output_tokens");
  expect(payload).not.toHaveProperty("response_format");
});
