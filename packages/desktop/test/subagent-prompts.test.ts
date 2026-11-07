import { readFileSync } from "node:fs";
import { expect, test } from "vitest";
import { prepareTaskOutputArguments } from "zpi-builtin-plugins/tasks/controls";
import { SessionManager } from "zpi-coding-agent";
import { chunk, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { SettingsStore } from "../src/main/storage.ts";
import { cleanup, codec, fixture, run } from "./helpers/context-fixture.ts";

// Captured from the checked-out ZCode provider descriptions and subagent prompt builders.
const reference = JSON.parse(
  readFileSync(new URL("./fixtures/zcode-subagents.json", import.meta.url), "utf8"),
) as Record<string, string>;
const schemas = JSON.parse(
  readFileSync(new URL("./fixtures/zcode-subagent-schemas.json", import.meta.url), "utf8"),
) as Record<string, Record<string, unknown>>;
const adapt = (text: string) =>
  text
    .replaceAll("ZCode CLI", "ZPI")
    .replaceAll("ZCode Explore", "ZPI Explore")
    .replaceAll(".zcode/agents/", ".zpi/agents/")
    .replaceAll("Use Read", "Use read")
    .replaceAll("Use Bash ONLY", "Use bash ONLY")
    .replaceAll("Write report/", "write report/");

test.each(["general-purpose", "Explore"].flatMap((name) => [false, true].map((codex) => ({ name, codex }))))(
  "sends the $name child prompt with Codex guidance=$codex to the model",
  async ({ name, codex }) => {
    const f = await fixture((body, response) => {
      const tools = body.tools as { function: { name: string } }[];
      const rows = body.messages as { role: string; content: string }[];
      if (tools.some((tool) => tool.function.name === "Agent") && !rows.some((row) => row.role === "tool")) {
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "launch",
                type: "function",
                function: {
                  name: "Agent",
                  arguments: JSON.stringify({
                    description: "Inspect source",
                    prompt: "Search",
                    subagent_type: name,
                  }),
                },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      } else {
        send(response, chunk({ content: "Findings" }));
        done(response);
      }
    });
    f.settings.setPluginOptions("zpi.collaboration", { promptPreset: codex ? "codex" : "default" });
    await run(f, "Use a subagent to research");
    const parent = f.server.requests[0];
    const parentInstructions = (parent.messages as { role: string; content: string }[])
      .filter((row) => ["system", "developer"].includes(row.role))
      .map((row) => row.content)
      .join("\n");
    expect(parentInstructions).not.toContain(adapt(reference.agent));
    expect(parentInstructions).not.toContain("- Agent:");
    const task = f.host.plugins.collaboration.list(f.session.id)[0];
    const child = f.server.requests.find(
      (request) =>
        !(request.tools as { function: { name: string } }[]).some((tool) => tool.function.name === "Agent"),
    );
    if (!child) throw new Error("Missing child request");
    const system = (child.messages as { role: string; content: string }[])
      .filter((row) => ["system", "developer"].includes(row.role))
      .map((row) => row.content)
      .join("\n");
    expect(system).toContain(adapt(reference[name === "Explore" ? "explore" : "generalPurpose"]));
    expect(system).toContain(adapt(reference.commonNotes));
    const parentTools = (
      parent.tools as {
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }[]
    ).map((entry) => entry.function);
    const description = parentTools.find((entry) => entry.name === "Agent")?.description ?? "";
    if (codex) {
      expect(description).toContain(
        "Do not launch subagents unless the user or applicable AGENTS.md/skill instructions explicitly ask",
      );
      expect(description).toContain(
        "Requests for depth, thoroughness, research, investigation, or detailed codebase analysis do not count as permission",
      );
      expect(description).toContain("Do not delegate urgent blocking work");
      expect(description).toContain("Do not duplicate work");
      expect(description).toContain("do meaningful non-overlapping work immediately");
      for (const capability of [
        "<system-reminder>",
        "run_in_background: true",
        "subagent_type",
        ".zpi/agents/*.md",
        "SendMessage",
        "TaskOutput",
        "agents share the workspace",
      ])
        expect(description).toContain(capability);
      expect(description).not.toContain("forked workspace");
      expect(parentInstructions).toContain("Handles self-contained implementation, debugging, and research");
      expect(parentInstructions).toContain("Read-only codebase exploration for a bounded question");
      expect(parentInstructions).not.toContain("not confident that you will find the right match");
    } else {
      expect(description).toBe(adapt(reference.agent));
      expect(parentInstructions).toContain("not confident that you will find the right match");
      expect(parentInstructions).toContain("when answering means sweeping many files");
    }
    for (const [tool, key] of [
      ["SendMessage", "sendMessage"],
      ["TaskStop", "taskStop"],
      ["TaskOutput", "taskOutput"],
    ])
      expect(parentTools.find((entry) => entry.name === tool)?.description).toBe(adapt(reference[key]));
    for (const [name, { $schema: _version, ...schema }] of Object.entries(schemas)) {
      if (name !== "RespondToCoordinator")
        expect(parentTools.find((entry) => entry.name === name)?.parameters).toEqual(schema);
    }
    const childTools = (
      child.tools as {
        function: { name: string; description: string; parameters: Record<string, unknown> };
      }[]
    ).map((entry) => entry.function);
    expect(childTools.find((entry) => entry.name === "RespondToCoordinator")?.description).toBe(
      reference.respondToCoordinator,
    );
    const { $schema: _version, ...responseSchema } = schemas.RespondToCoordinator;
    expect(childTools.find((entry) => entry.name === "RespondToCoordinator")?.parameters).toEqual(
      responseSchema,
    );
    expect(JSON.stringify(parent.messages)).toContain(reference.concurrency);
    expect(JSON.stringify(parent.messages)).toContain("<system-reminder>");
    expect(parentTools.find((entry) => entry.name === "TaskOutput")?.parameters.required).toEqual([
      "task_id",
      "block",
      "timeout",
    ]);
    const agentSchema = parentTools.find((entry) => entry.name === "Agent")?.parameters;
    expect(agentSchema?.required).toEqual(["description", "prompt"]);
    const rows = f.server.requests.at(-1)?.messages as { role: string; content: string }[];
    expect(rows.find((row) => row.role === "tool")?.content).toBe(
      `Findings\nagentId: ${task.agentId} (use SendMessage with to: '${task.agentId}' to continue this agent)\n<usage>tool_uses: ${task.totalToolUseCount}\nduration_ms: ${(task.endedAt as number) - task.startedAt}</usage>`,
    );
    const context = {
      cwd: f.workspace,
      model: fakeModel(""),
      sessionManager: SessionManager.inMemory(),
      isIdle: () => true,
      getSystemPrompt: () => "",
    };
    const reply = await f.host.plugins.collaboration
      .childTools(task.childSessionId)[0]
      .execute("reply", { summary: "Progress", message: "Done" }, undefined, undefined, context);
    expect(reply.content).toEqual([
      {
        type: "text",
        text: expect.stringMatching(
          /^Response response_[\w-]+ was queued for the coordinator\. Continue the current task unless the coordinator explicitly changed or ended it\.$/,
        ),
      },
    ]);
  },
);

test("TaskOutput applies ZCode runtime defaults and semantic booleans without accepting invalid nulls", () => {
  expect(prepareTaskOutputArguments({ task_id: "id" })).toEqual({
    task_id: "id",
    block: true,
    timeout: 30000,
  });
  expect(prepareTaskOutputArguments({ task_id: "id", block: "false", timeout: 0 })).toEqual({
    task_id: "id",
    block: false,
    timeout: 0,
  });
  expect(prepareTaskOutputArguments({ task_id: "id", timeout: null })).toMatchObject({ timeout: null });
});

test("persists Codex guidance and snapshots its mode on first send, including restored sessions", async () => {
  const f = await fixture();
  const description = () => {
    const tools = f.server.requests.at(-1)?.tools as { function: { name: string; description: string } }[];
    return tools.find((tool) => tool.function.name === "Agent")?.function.description ?? "";
  };
  const codexRule = "Do not launch subagents unless";
  expect(f.settings.get().plugins.options["zpi.collaboration"]?.promptPreset === "codex").toBe(false);
  await run(f, "original chat");
  expect(description()).toBe(adapt(reference.agent));
  const draft = await f.host.createSession(null);
  f.settings.setPluginOptions("zpi.collaboration", { promptPreset: "codex" });
  expect(f.host.listTools().find((tool) => tool.name === "Agent")?.description).toContain(codexRule);
  expect((await f.host.previewPrompt()).prompt).toContain(
    "Read-only codebase exploration for a bounded question",
  );
  await f.host.startRun({ sessionId: draft.id, text: "first send after enabling" });
  await f.host.activeRuns.get(draft.id)?.done;
  expect(description()).toContain(codexRule);
  f.settings.setPluginOptions("zpi.collaboration", { promptPreset: "default" });
  await f.host.startRun({ sessionId: draft.id, text: "keep Codex guidance" });
  await f.host.activeRuns.get(draft.id)?.done;
  expect(description()).toContain(codexRule);
  await f.host.close();
  const settings = new SettingsStore(f.dir, codec);
  expect(settings.get().plugins.options["zpi.collaboration"]?.promptPreset === "codex").toBe(false);
  settings.setPluginOptions("zpi.collaboration", { promptPreset: "codex" });
  const host = new SessionHost(f.dir, settings, f.resources, f.workspace, undefined);
  await host.init();
  cleanup.push(() => host.close());
  for (const [sessionId, codex] of [
    [f.session.id, false],
    [draft.id, true],
  ] as const) {
    await host.startRun({ sessionId, text: "continue after restart" });
    await host.activeRuns.get(sessionId)?.done;
    expect(description().includes(codexRule)).toBe(codex);
    const messages = JSON.stringify(f.server.requests.at(-1)?.messages);
    expect(messages.includes("not confident that you will find the right match")).toBe(!codex);
  }
});
