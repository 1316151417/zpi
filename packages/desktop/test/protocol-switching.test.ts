import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";

it("continues one persisted task across both protocols with all four tools, title generation and compaction", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ZPI-protocol-switch-"));
  await mkdir(join(dir, "agent"));
  await writeFile(join(dir, "agent/settings.json"), JSON.stringify({ compaction: { keepRecentTokens: 10 } }));
  const codec = {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value),
    decryptString: (value: Buffer) => value.toString(),
  };
  const settings = new SettingsStore(dir, codec);
  const requests: { url: string; body: Record<string, unknown>; headers: Headers }[] = [];
  const operations = [
    { name: "read", arguments: { path: "README.md" } },
    { name: "write", arguments: { path: "note.txt", content: "before\n" } },
    { name: "edit", arguments: { path: "note.txt", edits: [{ oldText: "before", newText: "after" }] } },
    { name: "bash", arguments: { command: "cat note.txt" } },
  ];
  const sse = (events: unknown[]) =>
    new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
      headers: { "content-type": "text/event-stream" },
    });
  const fetcher = (async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const isResponse = String(url).endsWith("/responses");
    const isTitle = String(body.instructions ?? JSON.stringify(body.messages)).includes("ZPI_SESSION_TITLE:");
    const text = isTitle
      ? '{"session_title":"协议切换测试"}'
      : isResponse
        ? "response answer"
        : "completion answer";
    if (!isTitle) requests.push({ url: String(url), body, headers: new Headers(init?.headers) });
    if (!isResponse)
      return sse([
        {
          id: "chat",
          model: "chat",
          choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
        },
      ]);
    const history = body.input as { type?: string; call_id?: string }[];
    const results = history.filter(
      (item) => item.type === "function_call_output" && item.call_id?.startsWith("call_response_"),
    );
    const operation = isTitle || !body.tools ? undefined : operations[results.length];
    const item = operation
      ? {
          type: "function_call",
          id: `fc_${results.length}`,
          call_id: `call_response_${results.length}`,
          namespace: "ZPI",
          name: operation.name,
          arguments: JSON.stringify(operation.arguments),
          status: "completed",
        }
      : {
          type: "message",
          id: "msg_done",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text, annotations: [] }],
        };
    return sse([
      { type: "response.output_item.done", item },
      {
        type: "response.completed",
        response: {
          id: "resp",
          model: "oauth",
          status: "completed",
          output: [item],
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 0 },
          },
        },
      },
    ]);
  }) as typeof fetch;
  settings.saveProvider({
    id: "chat",
    name: "Chat",
    baseUrl: "https://local.example/v1",
    apiKey: "chat-key",
    models: [{ id: "chat", reasoning: false }],
  });
  settings.saveProvider({
    id: "oauth",
    preset: "openai-chatgpt",
    name: "ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "oauth", reasoning: false }],
  });
  settings.saveChatGPTCredential("oauth", {
    access: "oauth-token",
    refresh: "refresh-token",
    expires: Date.now() + 3600000,
    clientId: "client",
    subject: "account",
    scopes: ["chatgpt.tokens.use.direct"],
    idToken: "id-token",
  });
  let host = new SessionHost(dir, settings, join(dir, "agent"), join(dir, "workspace"), fetcher, []);
  try {
    await writeFile(join(dir, "README.md"), "portable local history");
    await host.init();
    const project = await host.addProject(dir);
    const task = host.createSession(project.id);
    const run = async (text: string) => {
      await host.startRun({ sessionId: task.id, text });
      await host.activeRuns.get(task.id)?.done;
      expect(host.getSessionSnapshot(task.id).view.runs.at(-1)?.status).toBe("completed");
    };
    await host.setSessionSelection(task.id, { provider: "chat", modelId: "chat", reasoning: "none" });
    await run("first completion turn");
    await host.setSessionSelection(task.id, { provider: "oauth", modelId: "oauth", reasoning: "none" });
    await run("continue using four tools");
    expect(await readFile(join(dir, "note.txt"), "utf8")).toBe("after\n");
    const responseCalls = requests.filter((request) => request.url.endsWith("/responses"));
    expect(responseCalls).toHaveLength(5);
    const sessionId = responseCalls[0].headers.get("session_id");
    expect(sessionId).toBe(task.id);
    for (const request of responseCalls) {
      expect(request.headers.get("session_id")).toBe(sessionId);
      expect(request.headers.get("x-client-request-id")).toBe(sessionId);
      expect(request.body.prompt_cache_key).toBe(sessionId);
    }
    expect(JSON.stringify(responseCalls[0].body.input)).toContain("completion answer");
    expect(JSON.stringify(responseCalls.at(-1)?.body.input)).toContain("after");
    const measured = host.getSessionSnapshot(task.id).controls.usage;
    expect(measured.inputTokens).toBe(10);
    await host.close();
    host = new SessionHost(
      dir,
      new SettingsStore(dir, codec),
      join(dir, "agent"),
      join(dir, "workspace"),
      fetcher,
      [],
    );
    await host.init();
    await host.setSessionSelection(task.id, { provider: "chat", modelId: "chat", reasoning: "none" });
    expect(host.getSessionSnapshot(task.id).controls.usage.inputTokens).toBe(measured.inputTokens);
    expect(host.getSessionSnapshot(task.id).controls.usage.breakdown).toEqual(measured.breakdown);
    await run("continue after reopening");
    expect(host.getSessionSnapshot(task.id).controls.usage.inputTokens).toBe(measured.inputTokens);
    expect(host.getSessionSnapshot(task.id).controls.usage.breakdown).toEqual(measured.breakdown);
    const reverse = requests.at(-1)?.body.messages as {
      role: string;
      tool_call_id?: string;
      content?: string;
    }[];
    expect(
      reverse.filter((message) => message.role === "tool").map((message) => message.tool_call_id),
    ).toEqual(["call_response_0", "call_response_1", "call_response_2", "call_response_3"]);
    expect(JSON.stringify(reverse)).toContain("response answer");
    expect(JSON.stringify(reverse)).not.toContain("|fc_");
    await host.setSessionSelection(task.id, { provider: "oauth", modelId: "oauth", reasoning: "none" });
    await run("/compact");
    expect(requests.at(-1)?.headers.get("session_id")).not.toBe(sessionId);
    expect(requests.at(-1)?.body).not.toHaveProperty("prompt_cache_key");
    await run("continue after compaction");
    expect(requests.at(-1)?.headers.get("session_id")).toBe(sessionId);
    expect(requests.at(-1)?.body.prompt_cache_key).toBe(sessionId);
    for (const request of requests.filter((request) => request.url.endsWith("/chat/completions"))) {
      expect(request.headers.has("session_id")).toBe(false);
      expect(request.body).not.toHaveProperty("prompt_cache_key");
    }
    expect(host.getSessionSnapshot(task.id).controls.model).toEqual({ provider: "oauth", modelId: "oauth" });
    expect(JSON.stringify(host.getSessionSnapshot(task.id))).not.toContain("oauth-token");
  } finally {
    await host.close();
    await rm(dir, { recursive: true, force: true });
  }
});
