import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import { Agent } from "zpi-agent";
import { createAssistantMessageEventStream, emptyAssistant } from "zpi-ai";
import { projectStreamedToolJournal, SessionManager } from "zpi-coding-agent";
import { fakeModel } from "../../../tests/fake-server.ts";
import { StreamingToolJournal } from "../src/core/streaming-tool-journal.ts";
import { directory } from "./helpers/session-fixture.ts";

for (const mode of ["sequential", "parallel"] as const) {
  it(`durably closes every declared call after cancellation during ${mode} execution`, async () => {
    const cwd = await directory();
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    const journal = new StreamingToolJournal(manager, () => {});
    const model = fakeModel("http://localhost");
    const executed: string[] = [];
    const preflighted: string[] = [];
    const after: string[] = [];
    let agent: Agent;
    agent = new Agent({
      initialState: {
        model,
        tools: [
          {
            name: "inert",
            label: "Inert test tool",
            description: "Records calls without external side effects",
            parameters: Type.Object({}),
            async execute(id) {
              executed.push(id);
              // Stop while the first sequential call settles, as with a dismissed question.
              agent.abort();
              return { content: [{ type: "text", text: "first completed" }], details: undefined };
            },
          },
        ],
      },
      toolExecution: mode,
      beforeToolCall: async ({ toolCall }) => {
        preflighted.push(toolCall.id);
        // In parallel mode, stop during ordered preparation, before any handler starts.
        if (mode === "parallel") agent.abort();
      },
      afterToolCall: async ({ toolCall }) => {
        after.push(toolCall.id);
      },
      streamFn: () => {
        const stream = createAssistantMessageEventStream();
        const message = emptyAssistant(model);
        message.content = ["first", "second", "third"].map((id) => ({
          type: "toolCall",
          id,
          name: "inert",
          arguments: {},
        }));
        message.stopReason = "toolUse";
        stream.push({ type: "start", partial: message });
        stream.push({ type: "done", reason: "toolUse", message });
        return stream;
      },
    });
    // Exercise the same journal-before-canonical writer order as AgentSession.
    agent.subscribe((event) => {
      journal.observe(event);
      if (event.type === "message_end") manager.appendMessage(event.message);
    });
    await agent.prompt("run the inert batch");
    expect(executed).toEqual(mode === "sequential" ? ["first"] : []);
    expect(preflighted).toEqual(["first"]);
    expect(after).toEqual(mode === "sequential" ? ["first"] : []);
    const messages = manager.buildSessionContext().messages;
    const results = messages.filter((message) => message.role === "toolResult");
    expect(results.map((result) => result.toolCallId)).toEqual(["first", "second", "third"]);
    expect(results.slice(mode === "sequential" ? 1 : 0).every((result) => result.isError)).toBe(true);
    expect(manager.getLastEntry()).toMatchObject({ data: { committed: true } });
    expect(projectStreamedToolJournal(manager.getEntries())).toEqual(manager.getEntries());
    const path = manager.getSessionFile() as string;
    const before = await readFile(path, "utf8");
    expect(SessionManager.open(path).buildSessionContext().messages).toEqual(messages);
    expect(await readFile(path, "utf8")).toBe(before);
  });
}
