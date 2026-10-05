import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { deferred } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup } from "./helpers/host-fixture.ts";

type Item = Record<string, unknown>;
interface Request {
  responses: boolean;
  body: Item;
  workspace: string;
}
const sse = (events: unknown[]) =>
  new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

async function fixture(holdText?: string) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-responses-message-actions-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const codec = {
    isEncryptionAvailable: () => true,
    encryptString: (text: string) => Buffer.from(text),
    decryptString: (bytes: Buffer) => bytes.toString(),
  };
  const settings = new SettingsStore(dir, codec);
  settings.saveProvider({
    id: "chat",
    name: "Chat",
    baseUrl: "https://local.example/v1",
    apiKey: "fake-key",
    models: [{ id: "chat", input: ["text", "image"], reasoning: false }],
  });
  settings.saveProvider({
    id: "oauth",
    preset: "openai-chatgpt",
    name: "ChatGPT",
    baseUrl: "https://api.openai.com/v1",
    models: [{ id: "oauth", input: ["text", "image"], reasoning: true }],
  });
  settings.saveChatGPTCredential("oauth", {
    access: "fake-oauth",
    refresh: "fake-refresh",
    expires: Date.now() + 3600000,
    clientId: "fake-client",
    subject: "fake-account",
    scopes: ["chatgpt.tokens.use.direct"],
    idToken: "fake-id-token",
  });
  const requests: Request[] = [];
  let serial = 0;
  const file = join(dir, "note.txt");
  await writeFile(file, "original");
  const fetcher = (async (url, init) => {
    const body = JSON.parse(String(init?.body)) as Item;
    const responses = String(url).endsWith("/responses");
    const title = String(body.instructions ?? JSON.stringify(body.messages)).includes("ZPI_SESSION_TITLE:");
    const items = (responses ? body.input : body.messages) as Item[];
    const lastUser = items.findLastIndex((item) => item.role === "user");
    const user = items[lastUser];
    const text = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
    const answered = items
      .slice(lastUser + 1)
      .some((item) => item.type === "function_call_output" || item.role === "tool");
    const tool = !title && body.tools && text.includes("[write]") && !answered;
    const id = ++serial;
    if (!title) requests.push({ responses, body, workspace: await readFile(file, "utf8") });
    if (responses && !title && text === holdText) {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              [
                {
                  type: "response.output_item.done",
                  item: {
                    type: "reasoning",
                    id: "rs_abandoned",
                    summary: [],
                    encrypted_content: "abandoned-signature",
                  },
                },
                {
                  type: "response.output_text.delta",
                  item_id: "msg_abandoned",
                  content_index: 0,
                  delta: "abandoned partial",
                },
              ]
                .map((event) => `data: ${JSON.stringify(event)}\n\n`)
                .join(""),
            ),
          );
          init?.signal?.addEventListener(
            "abort",
            () => controller.error(new DOMException("Aborted", "AbortError")),
            { once: true },
          );
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    const reply = title ? '{"session_title":"Responses history"}' : `answer ${text}`;
    if (!responses) {
      return sse([
        {
          id: `chat_${id}`,
          model: "chat",
          choices: [
            {
              index: 0,
              delta: tool
                ? {
                    tool_calls: [
                      {
                        index: 0,
                        id: `call_${id}`,
                        type: "function",
                        function: {
                          name: "write",
                          arguments: JSON.stringify({ path: "note.txt", content: text }),
                        },
                      },
                    ],
                  }
                : { content: reply },
              finish_reason: tool ? "tool_calls" : "stop",
            },
          ],
        },
      ]);
    }
    const reasoning = {
      type: "reasoning",
      id: `rs_${id}`,
      summary: [{ type: "summary_text", text: `plan ${text}` }],
      encrypted_content: `encrypted_${id}`,
    };
    const result = tool
      ? {
          type: "function_call",
          id: `fc_${id}`,
          call_id: `call_${id}`,
          namespace: "zpi",
          name: "write",
          arguments: JSON.stringify({ path: "note.txt", content: text }),
          status: "completed",
        }
      : {
          type: "message",
          id: `msg_${id}`,
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: reply, annotations: [] }],
        };
    return sse([
      { type: "response.output_item.done", item: reasoning },
      { type: "response.output_item.done", item: result },
      {
        type: "response.completed",
        response: {
          id: `resp_${id}`,
          model: "oauth",
          status: "completed",
          output: [reasoning, result],
        },
      },
    ]);
  }) as typeof fetch;
  const open = async () => {
    const host = new SessionHost(
      dir,
      new SettingsStore(dir, codec),
      join(dir, "agent"),
      join(dir, "workspace"),
      fetcher,
      [],
    );
    await host.init();
    cleanup.push(() => host.close());
    return host;
  };
  const host = await open();
  const project = await host.addProject(dir);
  const task = host.createSession(project.id);
  const select = (owner: SessionHost, id: string, provider: string) =>
    owner.setSessionSelection(id, {
      provider,
      modelId: provider,
      reasoning: provider === "chat" ? "none" : "high",
    });
  const run = async (owner: SessionHost, id: string, text: string) => {
    const result = await owner.startRun({ sessionId: id, text });
    await owner.activeRuns.get(id)?.done;
    expect(owner.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
    return result;
  };
  const transcript = (id: string) =>
    readFile(join(dir, "agent", "sessions", project.id, `${id}.jsonl`), "utf8");
  return { host, open, requests, select, run, task, file, transcript };
}

function expectPairs(request: Request) {
  const items = (request.responses ? request.body.input : request.body.messages) as Item[];
  if (request.responses) {
    expect(request.body.store).toBe(false);
    expect(request.body).not.toHaveProperty("previous_response_id");
    expect(request.body).not.toHaveProperty("conversation");
    const calls = items.filter((item) => item.type === "function_call");
    const outputs = items.filter((item) => item.type === "function_call_output");
    expect(outputs.map((item) => item.call_id)).toEqual(calls.map((item) => item.call_id));
    expect(new Set(calls.map((item) => item.call_id)).size).toBe(calls.length);
  } else {
    const calls = items.flatMap((item) => (item.tool_calls as Item[] | undefined) ?? []);
    expect(items.filter((item) => item.role === "tool").map((item) => item.tool_call_id)).toEqual(
      calls.map((item) => item.id),
    );
    expect(JSON.stringify(items)).not.toContain("encrypted_");
    expect(JSON.stringify(items)).not.toContain("|fc_");
  }
}

function historyText(request: Request): string {
  const items = (request.responses ? request.body.input : request.body.messages) as Item[];
  return JSON.stringify(items.filter((item) => item.role !== "system"));
}

it.each([
  ["oauth", "oauth"],
  ["oauth", "chat"],
  ["chat", "oauth"],
  ["chat", "chat"],
])(
  "rewind, edit, fork and restart keep paired tools and retained reasoning across %s → %s",
  async (initial, replacement) => {
    const f = await fixture();
    await f.select(f.host, f.task.id, initial);
    const first = await f.run(f.host, f.task.id, "retained [write]");
    await f.select(f.host, f.task.id, "oauth");
    const beforeSecond = f.requests.length;
    const second = await f.run(f.host, f.task.id, "discarded [write]");
    const retainedInput = f.requests[beforeSecond].body.input as Item[];
    const retainedReasoning = retainedInput.filter((item) => item.type === "reasoning");
    expect(retainedReasoning.length).toBe(initial === "oauth" ? 2 : 0);
    await f.select(f.host, f.task.id, replacement);
    const beforeEdit = f.requests.length;
    const edited = await f.host.editUserMessage(f.task.id, second.runId, {
      text: "replacement",
      workspaceMode: "rewind",
    });
    expect(edited).not.toHaveProperty("conflicts");
    await f.host.activeRuns.get(f.task.id)?.done;
    const replay = f.requests[beforeEdit];
    expect(replay.workspace).toBe("retained [write]");
    expectPairs(replay);
    expect(JSON.stringify(replay.body)).toContain("retained [write]");
    expect(JSON.stringify(replay.body)).not.toContain("discarded");
    if (replacement === "oauth")
      expect((replay.body.input as Item[]).filter((item) => item.type === "reasoning")).toEqual(
        retainedReasoning,
      );
    expect(f.host.getSessionSnapshot(f.task.id).view.runs.map((run) => run.userMessage)).toEqual([
      "retained [write]",
      "replacement",
    ]);
    const parent = await f.transcript(f.task.id);
    const child = await f.host.forkSession(f.task.id, first.runId);
    expect(await f.transcript(f.task.id)).toBe(parent);
    await f.host.deleteSession(f.task.id);
    await f.host.close();
    const restored = await f.open();
    await f.select(restored, child.id, replacement);
    const beforeChild = f.requests.length;
    await f.run(restored, child.id, "child continuation");
    const forkRequest = f.requests[beforeChild];
    expectPairs(forkRequest);
    expect(JSON.stringify(forkRequest.body)).toContain("retained [write]");
    expect(historyText(forkRequest)).not.toContain("replacement");
    expect(JSON.stringify(forkRequest.body)).not.toContain("discarded");
    if (replacement === "oauth")
      expect((forkRequest.body.input as Item[]).filter((item) => item.type === "reasoning")).toEqual(
        retainedReasoning,
      );
    expect(await restored.getChanges(child.id, first.runId)).toHaveLength(1);
  },
);

it("editing a running Responses reply removes partial text and its reasoning while preserving prior tools and the paused queue", async () => {
  const f = await fixture("hold running");
  await f.select(f.host, f.task.id, "oauth");
  await f.run(f.host, f.task.id, "retained [write]");
  const partial = deferred();
  const unsubscribe = f.host.subscribe(({ event }) => {
    if (event.type === "block_delta" && event.delta === "abandoned partial") partial.resolve();
  });
  cleanup.push(async () => unsubscribe());
  const held = await f.host.startRun({ sessionId: f.task.id, text: "hold running" });
  await partial.promise;
  await f.host.submitInput({ sessionId: f.task.id, text: "queued input" });
  const beforeEdit = f.requests.length;
  await f.host.editUserMessage(f.task.id, held.runId, { text: "replacement after abort" });
  await f.host.activeRuns.get(f.task.id)?.done;
  const request = f.requests[beforeEdit];
  expectPairs(request);
  expect(historyText(request)).not.toContain("hold running");
  expect(historyText(request)).not.toContain("abandoned");
  expect(historyText(request)).toContain("retained [write]");
  const view = f.host.getSessionSnapshot(f.task.id).view;
  expect(view.runs.map((run) => run.userMessage)).toEqual(["retained [write]", "replacement after abort"]);
  expect(view.runs.at(-1)?.status).toBe("completed");
  expect(view.queue?.items.map((item) => item.text)).toEqual(["queued input"]);
});

it("compacted Responses history keeps valid boundaries through edit, fork and process restart", async () => {
  const f = await fixture();
  await f.select(f.host, f.task.id, "oauth");
  await f.run(f.host, f.task.id, "older [write]");
  await f.run(f.host, f.task.id, "kept [write]");
  await f.run(f.host, f.task.id, "/compact");
  expect(await f.transcript(f.task.id)).toContain('"type":"compaction"');
  const last = await f.run(f.host, f.task.id, "post compact discard");
  const beforeEdit = f.requests.length;
  await f.host.editUserMessage(f.task.id, last.runId, { text: "post compact replacement" });
  await f.host.activeRuns.get(f.task.id)?.done;
  expectPairs(f.requests[beforeEdit]);
  expect(JSON.stringify(f.requests[beforeEdit].body.input)).toContain("Summary of earlier conversation:");
  expect(JSON.stringify(f.requests[beforeEdit].body.input)).not.toContain("post compact discard");
  const turn = f.host.getSessionSnapshot(f.task.id).view.runs.at(-1);
  if (!turn) throw new Error("missing edited turn");
  const child = await f.host.forkSession(f.task.id, turn.runId);
  await f.host.close();
  const restored = await f.open();
  const beforeChild = f.requests.length;
  await f.run(restored, child.id, "continue compacted fork");
  expectPairs(f.requests[beforeChild]);
  expect(JSON.stringify(f.requests[beforeChild].body.input)).toContain("Summary of earlier conversation:");
  expect(JSON.stringify(f.requests[beforeChild].body.input)).toContain("post compact replacement");
});
