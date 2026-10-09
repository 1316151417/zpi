import type { JsonObject } from "ZPI-ai";
import { createAssistantMessageEventStream, emptyAssistant } from "ZPI-ai";
import {
  createAgentSession,
  createEditTool,
  createWriteTool,
  ModelRuntime,
  projectStreamedToolJournal,
  SessionManager,
  SettingsManager,
} from "ZPI-coding-agent";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { deferred, fakeConfig } from "../../../tests/fake-server.ts";
import { withFileMutationQueue } from "../src/core/tools/pi/file-mutation-queue.ts";
import { directory } from "./helpers/session-fixture.ts";

it("SDK sessions run ordinary calls in parallel and persist their results in declaration order", async () => {
  const cwd = await directory();
  const first = deferred(),
    second = deferred(),
    release = deferred();
  let requests = 0;
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    models: [fakeConfig("")],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message = emptyAssistant(model);
      message.content =
        ++requests === 1
          ? ["first", "second"].map((id) => ({
              type: "toolCall" as const,
              id,
              name: "ordinary",
              arguments: {},
            }))
          : [{ type: "text", text: "done" }];
      message.stopReason = requests === 1 ? "toolUse" : "stop";
      stream.push({ type: "start", partial: message });
      stream.end(message);
      return stream;
    },
  });
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    cwd,
    agentDir: join(cwd, "agent"),
    userSkillPaths: [],
    modelRuntime: runtime,
    sessionManager: manager,
    noTools: "builtin",
    customTools: [
      {
        name: "ordinary",
        label: "Ordinary",
        description: "ordinary",
        parameters: Type.Object({}),
        async execute(id) {
          if (id === "first") {
            first.resolve();
            await release.promise;
          } else second.resolve();
          return { content: [{ type: "text", text: id }], details: undefined };
        },
      },
    ],
  });
  try {
    const run = session.prompt("run both");
    await first.promise;
    await second.promise;
    release.resolve();
    await run;
    const reopened = SessionManager.open(manager.getSessionFile() as string);
    expect(
      reopened
        .buildSessionContext()
        .messages.filter((m) => m.role === "toolResult")
        .map((m) => m.toolCallId),
    ).toEqual(["first", "second"]);
  } finally {
    release.resolve();
    session.dispose();
  }
});

for (const recovery of [false, true]) {
  it(`executes built-in read before Responses completes and ${recovery ? "recovers without executing writes" : "reuses its persisted result"}`, async () => {
    const cwd = await directory();
    await writeFile(join(cwd, "README.md"), "read during generation");
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const requests: JsonObject[] = [];
    const connected = deferred();
    const call = {
      type: "function_call",
      id: "fc_read",
      call_id: "read",
      name: "read",
      arguments: '{"path":"README.md"}',
      status: "completed",
    };
    const write = {
      type: "function_call",
      id: "fc_write",
      call_id: "write",
      name: "write",
      arguments: '{"path":"never.txt","content":"never"}',
      status: "completed",
    };
    const text = {
      type: "message",
      id: "msg",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "finished", annotations: [] }],
    };
    const terminal = (output: unknown[]) => ({
      type: "response.completed",
      response: { id: "response", status: "completed", model: "fake", output },
    });
    const send = (event: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
    const runtime = await ModelRuntime.create({
      fetch: (async (_, init) => {
        requests.push(JSON.parse(String(init?.body)));
        if (requests.length > 1) {
          expect(requests.at(-1)?.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: "function_call_output",
                call_id: "read",
                output: "read during generation",
              }),
            ]),
          );
          if (recovery)
            expect(JSON.stringify(requests.at(-1)?.input)).toContain("before this tool was executed");
          return new Response(`data: ${JSON.stringify(terminal([text]))}\n\n`, {
            headers: { "content-type": "text/event-stream" },
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(c) {
              controller = c;
              connected.resolve();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }) as typeof fetch,
    });
    runtime.registerProvider("fake", {
      apiKey: "local",
      models: [{ ...fakeConfig(""), api: "openai-responses" }],
    });
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const { session } = await createAgentSession({
      cwd,
      agentDir: join(cwd, "agent"),
      userSkillPaths: [],
      modelRuntime: runtime,
      sessionManager: manager,
      settingsManager: SettingsManager.inMemory({ retry: { baseDelayMs: 0 } }),
    });
    const closed = deferred(),
      ended = deferred(),
      writeClosed = deferred();
    let reads = 0;
    session.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "toolcall_end")
        closed.resolve();
      if (
        event.type === "message_update" &&
        event.assistantMessageEvent.type === "toolcall_end" &&
        event.assistantMessageEvent.toolCall.name === "write"
      )
        writeClosed.resolve();
      if (event.type === "tool_execution_end" && event.toolName === "read") {
        reads++;
        ended.resolve();
      }
    });
    try {
      const run = session.prompt("read while generating");
      await connected.promise;
      send({ type: "response.output_item.added", item: { ...call, arguments: "" } });
      send({ type: "response.function_call_arguments.delta", item_id: call.id, delta: call.arguments });
      send({ type: "response.output_item.done", item: call });
      await closed.promise;
      await ended.promise;
      expect(session.isStreaming).toBe(true);
      expect(requests).toHaveLength(1);
      // Both the call and its result survive a crash before the model finishes.
      const journaled = projectStreamedToolJournal(manager.getEntries());
      expect(
        journaled.find((entry) => entry.type === "message" && entry.message.role === "toolResult"),
      ).toMatchObject({
        message: {
          toolCallId: "read|fc_read",
          content: [{ text: "read during generation" }],
          isError: false,
        },
      });
      if (recovery) {
        send({ type: "response.output_item.done", item: write });
        await writeClosed.promise;
        controller.error(Object.assign(new Error("network error: connection reset"), { code: "ECONNRESET" }));
      } else {
        send(terminal([call]));
        controller.close();
      }
      await run;
      expect(requests).toHaveLength(2);
      expect(reads).toBe(1);
      expect(session.messages.at(-1)).toMatchObject({ content: [{ text: "finished" }] });
      const reopened = SessionManager.open(manager.getSessionFile() as string);
      expect(reopened.buildSessionContext().messages.filter((m) => m.role === "toolResult")).toHaveLength(
        recovery ? 2 : 1,
      );
      await expect(access(join(cwd, "never.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      session.abort();
      session.dispose();
    }
  });
}

it("the Pi mutation queue serializes write then edit on the same file", async () => {
  const cwd = await directory();
  const write = createWriteTool(cwd),
    edit = createEditTool(cwd);
  const written = write.execute("write", { path: "same.txt", content: "before\n" });
  const edited = edit.execute("edit", { path: "same.txt", edits: [{ oldText: "before", newText: "after" }] });
  await Promise.all([written, edited]);
  expect(await readFile(join(cwd, "same.txt"), "utf8")).toBe("after\n");
});

it("the Pi mutation queue leaves different files independent while keeping each file ordered", async () => {
  const cwd = await directory();
  const started = deferred(),
    release = deferred(),
    independent = deferred();
  const order: string[] = [];
  const first = withFileMutationQueue(join(cwd, "a"), async () => {
    order.push("a1");
    started.resolve();
    await release.promise;
  });
  await started.promise;
  const same = withFileMutationQueue(join(cwd, "a"), async () => {
    order.push("a2");
  });
  const other = withFileMutationQueue(join(cwd, "b"), async () => {
    order.push("b");
    independent.resolve();
  });
  await independent.promise;
  expect(order).toEqual(["a1", "b"]);
  release.resolve();
  await Promise.all([first, same, other]);
  expect(order).toEqual(["a1", "b", "a2"]);
});
