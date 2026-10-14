import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { expect, it } from "vitest";
import {
  createAgentSession,
  ModelRuntime,
  projectStreamedToolJournal,
  SessionManager,
} from "zpi-coding-agent";
import { chunk, deferred, done, fakeConfig, fakeServer, send } from "../../../tests/fake-server.ts";
import { cleanup, directory } from "./helpers/session-fixture.ts";

for (const writeFirst of [true, false]) {
  it(`durably checkpoints a parallel write ${writeFirst ? "before" : "after"} a pending call in declaration order`, async () => {
    const cwd = await directory();
    const release = deferred(),
      written = deferred(),
      waiting = deferred();
    const calls = [
      { id: "write-1", name: "write", arguments: { path: "created.txt", content: "persist me" } },
      { id: "wait-1", name: "bash", arguments: { command: "test-only gate" } },
    ];
    if (!writeFirst) calls.reverse();
    const server = await fakeServer((_, response, index) => {
      if (index === 0) {
        send(
          response,
          chunk({
            tool_calls: calls.map((call, index) => ({
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            })),
          }),
        );
        done(response, "tool_calls");
      } else {
        send(response, chunk({ content: "done" }));
        done(response);
      }
    });
    cleanup.push(server.close);
    const runtime = await ModelRuntime.create();
    runtime.registerProvider("fake", {
      baseUrl: server.url,
      models: [fakeConfig(server.url)],
      apiKey: "local",
    });
    const manager = SessionManager.create(cwd, join(cwd, "sessions"));
    let executions = 0;
    const { session } = await createAgentSession({
      cwd,
      homeDir: join(cwd, "home"),
      agentDir: join(cwd, "agent"),
      modelRuntime: runtime,
      sessionManager: manager,
      toolOverrides: [
        {
          name: "bash",
          label: "Test gate",
          description: "Test-only inert gate",
          parameters: Type.Object({ command: Type.String() }),
          async execute() {
            executions++;
            waiting.resolve();
            await release.promise;
            return { content: [{ type: "text", text: "released" }], details: undefined };
          },
        },
      ],
    });
    session.subscribe((event) => {
      if (event.type === "tool_execution_end" && event.toolCallId === "write-1") written.resolve();
    });
    const running = session.prompt("make the write and wait in parallel");
    try {
      await Promise.all([written.promise, waiting.promise]);
      expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("persist me");
      expect(session.isStreaming).toBe(true);
      expect(manager.buildSessionContext().messages.filter((m) => m.role === "toolResult")).toHaveLength(0);
      const projected = projectStreamedToolJournal(manager.getEntries());
      expect(
        projected.flatMap((entry) =>
          entry.type === "message" && entry.message.role === "toolResult" ? [entry.message.toolCallId] : [],
        ),
      ).toEqual(calls.map((call) => call.id));
      // Copy only durable bytes, as if the process died while the other call was pending.
      const snapshot = join(cwd, "crash-snapshot.jsonl");
      await copyFile(manager.getSessionFile() as string, snapshot);
      const recovered = SessionManager.open(snapshot).buildSessionContext().messages;
      const results = recovered.filter((message) => message.role === "toolResult");
      expect(results.map((message) => message.toolCallId)).toEqual(calls.map((call) => call.id));
      expect(results.find((message) => message.toolCallId === "write-1")).toMatchObject({ isError: false });
      expect(results.find((message) => message.toolCallId === "wait-1")).toMatchObject({
        isError: true,
        details: { reason: "unknown_execution_state" },
      });
      const recoveredBytes = await readFile(snapshot, "utf8");
      SessionManager.open(snapshot);
      expect(await readFile(snapshot, "utf8")).toBe(recoveredBytes);
      expect(executions).toBe(1);
      await writeFile(join(cwd, "created.txt"), "inspected after interruption");
      const resumed = await createAgentSession({
        cwd,
        homeDir: join(cwd, "home"),
        agentDir: join(cwd, "agent"),
        modelRuntime: runtime,
        sessionManager: SessionManager.open(snapshot),
        toolOverrides: [
          {
            name: "bash",
            label: "Replay detector",
            description: "Test-only replay detector",
            parameters: Type.Object({ command: Type.String() }),
            async execute() {
              executions++;
              return { content: [{ type: "text", text: "unexpected replay" }], details: undefined };
            },
          },
        ],
      });
      try {
        await resumed.session.prompt("continue after the interruption");
        expect(await readFile(join(cwd, "created.txt"), "utf8")).toBe("inspected after interruption");
        expect(executions).toBe(1);
        expect(resumed.session.messages.filter((message) => message.role === "toolResult")).toEqual(results);
      } finally {
        resumed.session.dispose();
      }
      release.resolve();
      await running;
      const completed = SessionManager.open(manager.getSessionFile() as string).buildSessionContext()
        .messages;
      expect(completed.filter((message) => message.role === "toolResult")).toMatchObject(
        calls.map((call) => ({ toolCallId: call.id, isError: false })),
      );
      expect(projectStreamedToolJournal(manager.getEntries())).toEqual(manager.getEntries());
    } finally {
      release.resolve();
      await running;
      session.dispose();
    }
  });
}
