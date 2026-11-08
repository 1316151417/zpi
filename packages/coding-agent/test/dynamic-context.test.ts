import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentText, getCurrentSystemPrompt, type SystemMessage } from "@zpi-dev/ai";
import {
  buildSystemContext,
  createAgentSession,
  SessionManager,
  type SessionPlugin,
} from "@zpi-dev/coding-agent";
import { expect, test } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { contextUpdate } from "../src/core/dynamic-context.ts";
import { fixture, skill } from "./helpers/resource-fixture.ts";
import { directory } from "./helpers/session-fixture.ts";

const key = (owner: string, name: string) => JSON.stringify(["plugin", owner, name]);
function updates(manager: SessionManager): SystemMessage[] {
  return manager.buildSessionContext().messages.filter((message) => message.role === "system");
}
function appendUpdate(manager: SessionManager, current: Record<string, string>) {
  const update = contextUpdate(manager.buildSessionContext().messages, current);
  assert(update);
  manager.appendMessage(update);
  return update;
}
const answer = (_body: unknown, response: Parameters<typeof send>[0]) => {
  send(response, chunk({ content: "ANSWER" }));
  done(response);
};

test("base configuration, custom additions, tool guidance and environment have independent update keys", () => {
  const options = {
    cwd: "/project",
    projectName: "ONE",
    platform: "test",
    template: {
      id: "test",
      name: "Test",
      preamble: "BASE {{project_name}} {{platform}}",
      rules: "BASE_RULE",
    },
    tools: [
      { name: "read", description: "Read", promptSnippet: "READ_SHORT", promptGuidelines: ["TOOL_RULE"] },
    ],
    customInstructions: ["EXTRA"],
  };
  const initial = buildSystemContext(options);
  const messages: SystemMessage[] = [
    {
      role: "system",
      content: "",
      sections: { "zpi.base": initial.base, ...initial.sections },
      timestamp: 0,
    },
  ];
  for (const [changes, keys] of [
    [{ projectName: "TWO" }, ["zpi.base"]],
    [{ platform: "other" }, ["zpi.base"]],
    [{ baseInstructions: "EXPLICIT_BASE" }, ["zpi.base"]],
    [{ customInstructions: ["DIFFERENT"] }, ["zpi.custom"]],
    [{ cwd: "/other" }, ["zpi.environment"]],
    [{ tools: [] }, ["zpi.tools", "zpi.tool-rules"]],
  ] as const) {
    const next = buildSystemContext({ ...options, ...changes });
    expect(
      Object.keys(contextUpdate(messages, { "zpi.base": next.base, ...next.sections })?.sections ?? {}),
    ).toEqual(keys);
  }
});

test("SDK appends only changed plugin blocks, scopes names, withdraws missing blocks and preserves the wire prefix", async () => {
  let blocks: Record<string, string> = { agents: "AGENTS_ONE", memory: "MEMORY_ONE" };
  const plugins: SessionPlugin[] = [
    {
      id: "inventory",
      version: "1",
      instructions: ["STATIC_PLUGIN_RULE"],
      contextInstructions: () => blocks,
    },
    { id: "other", version: "1", contextInstructions: () => ({ agents: "OTHER_OWNER" }) },
  ];
  const f = await fixture(answer, { plugins });
  await f.session.prompt("first");
  const count = updates(f.manager).length;
  await f.session.prompt("unchanged");
  expect(updates(f.manager)).toHaveLength(count);
  const first = f.server.requests[0].messages as unknown[];
  expect((f.server.requests[1].messages as unknown[]).slice(0, first.length)).toEqual(first);
  blocks = { ...blocks, agents: "AGENTS_TWO" };
  await f.session.prompt("changed");
  expect(updates(f.manager).at(-1)?.sections).toEqual({ [key("inventory", "agents")]: "AGENTS_TWO" });
  const second = f.server.requests[1].messages as unknown[];
  expect((f.server.requests[2].messages as unknown[]).slice(0, second.length)).toEqual(second);
  blocks = { agents: "AGENTS_TWO" };
  await f.session.prompt("withdraw memory");
  expect(updates(f.manager).at(-1)?.sections).toEqual({ [key("inventory", "memory")]: null });
  expect(f.session.systemPrompt).not.toContain("MEMORY_ONE");
  expect(f.session.systemPrompt).toContain("OTHER_OWNER");
  const afterWithdrawal = updates(f.manager).length;
  await f.session.prompt("still withdrawn");
  expect(updates(f.manager)).toHaveLength(afterWithdrawal);
  const wire = JSON.stringify(f.server.requests.at(-1)?.messages);
  expect(wire).toContain("is withdrawn");
  expect((f.server.requests[f.server.requests.length - 1].messages as unknown[])[0]).toEqual(first[0]);
  f.session.dispose();
  const file = f.manager.getSessionFile();
  assert(file);
  const reopened = await createAgentSession({
    cwd: f.cwd,
    agentDir: f.agentDir,
    homeDir: join(f.dir, "home"),
    modelRuntime: f.runtime,
    sessionManager: SessionManager.open(file),
    plugins: [plugins[1]],
  });
  try {
    await reopened.session.prompt("plugin removed");
    expect(reopened.session.messages.findLast((message) => message.role === "system")).toMatchObject({
      sections: { [JSON.stringify(["plugin", "inventory"])]: null, [key("inventory", "agents")]: null },
    });
    expect(reopened.session.systemPrompt).not.toMatch(/STATIC_PLUGIN_RULE|AGENTS_TWO|MEMORY_ONE/);
    expect(reopened.session.systemPrompt).toContain("OTHER_OWNER");
  } finally {
    reopened.session.dispose();
  }
});

test("resume keeps prepared plugin state until existing prompt hooks refresh it, without spurious withdrawals", async () => {
  let prepared = false;
  const plugin: SessionPlugin = {
    id: "prepared-memory",
    version: "1",
    contextInstructions: (): Record<string, string> => (prepared ? { memory: "KNOWN_MEMORY" } : {}),
    hooks: [
      {
        event: "UserPromptSubmit",
        handler: () => {
          prepared = true;
        },
      },
    ],
  };
  const f = await fixture(answer, { plugins: [plugin] });
  await f.session.prompt("first");
  const count = updates(f.manager).length;
  const file = f.manager.getSessionFile();
  assert(file);
  f.session.dispose();
  prepared = false;
  const manager = SessionManager.open(file);
  const { session } = await createAgentSession({
    cwd: f.cwd,
    agentDir: f.agentDir,
    homeDir: join(f.dir, "home"),
    modelRuntime: f.runtime,
    sessionManager: manager,
    plugins: [plugin],
  });
  try {
    expect(session.systemPrompt).toContain("KNOWN_MEMORY");
    expect(updates(manager)).toHaveLength(count);
    await session.prompt("resume");
    expect(updates(manager)).toHaveLength(count);
    expect(session.systemPrompt).toContain("KNOWN_MEMORY");
  } finally {
    session.dispose();
  }
});

test("project instructions and skill catalogs refresh independently and withdraw on removal", async () => {
  const f = await fixture(answer);
  await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT_ONE");
  await skill(join(f.cwd, ".agents/skills"), "local", "SKILL_ONE");
  await f.session.prompt("resources");
  expect(updates(f.manager).at(-1)?.sections).toMatchObject({
    "zpi.resources": expect.stringContaining("PROJECT_ONE"),
    "zpi.skills": expect.stringContaining("SKILL_ONE"),
  });
  await writeFile(join(f.cwd, "AGENTS.md"), "PROJECT_TWO");
  await f.session.prompt("instructions changed");
  expect(Object.keys(updates(f.manager).at(-1)?.sections ?? {})).toEqual(["zpi.resources"]);
  await rm(join(f.cwd, "AGENTS.md"));
  await rm(join(f.cwd, ".agents/skills"), { recursive: true });
  await f.session.prompt("resources removed");
  expect(updates(f.manager).at(-1)?.sections).toEqual({ "zpi.resources": null, "zpi.skills": null });
});

test("existing tool hooks feed the shared context sync before continuation requests", async () => {
  let state = "BEFORE_TOOL";
  const f = await fixture(
    (body, response, index) => {
      if (index === 0) {
        send(
          response,
          chunk({
            tool_calls: [
              {
                index: 0,
                id: "write",
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ path: "file", content: "value" }) },
              },
            ],
          }),
        );
        done(response, "tool_calls");
      } else answer(body, response);
    },
    {
      plugins: [{ id: "tool-state", version: "1", contextInstructions: () => ({ state }) }],
      hooks: [
        {
          event: "PostToolUse",
          handler: () => {
            state = "AFTER_TOOL";
          },
        },
      ],
    },
  );
  await f.session.prompt("write");
  const messages = f.server.requests[1].messages as { role: string; content: string }[];
  const tool = messages.findIndex((message) => message.role === "tool");
  const update = messages.findIndex((message) => message.content?.includes("AFTER_TOOL"));
  expect(update).toBeGreaterThan(tool);
  expect(updates(f.manager).at(-1)?.sections).toEqual({ [key("tool-state", "state")]: "AFTER_TOOL" });
});

test("resume, historical forks and repeated compactions retain current blocks and tombstones separately from the base", async () => {
  const cwd = await directory();
  await mkdir(join(cwd, "sessions"));
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  manager.appendMessage({
    role: "system",
    content: "BASE",
    sections: { "zpi.base": "BASE_RULES", "external.note": "EXTERNAL_NOTE" },
    timestamp: 0,
  });
  const initial = { "zpi.base": "BASE_RULES", "zpi.agents": "AGENT_ONE", "zpi.memory": "MEMORY_OLD" };
  appendUpdate(manager, initial);
  const kept = manager.appendMessage({ role: "user", content: "retained", timestamp: 1 });
  const historical = manager.getEntries();
  const current = { "zpi.base": "BASE_RULES", "zpi.agents": "AGENT_TWO" };
  appendUpdate(manager, current);
  manager.appendCompaction("Old memory and agent references in the summary are historical.", kept);
  const projected = manager.buildSessionContext().messages;
  expect(projected[0]).toMatchObject({
    content: "BASE",
    sections: { "zpi.base": "BASE_RULES", "external.note": "EXTERNAL_NOTE" },
  });
  expect(projected.at(-1)).toMatchObject({ sections: { "zpi.agents": "AGENT_TWO", "zpi.memory": null } });
  expect(contentText(projected[1].content)).toContain("Summary of earlier conversation");
  expect(contextUpdate(projected, current)).toBeUndefined();
  const file = manager.getSessionFile();
  assert(file);
  const restored = SessionManager.open(file);
  expect(restored.buildSessionContext().messages).toEqual(projected);
  expect(contextUpdate(restored.buildSessionContext().messages, current)).toBeUndefined();
  const fork = SessionManager.create(cwd, join(cwd, "sessions"));
  fork.replaceEntries(historical);
  const forkUpdate = appendUpdate(fork, current);
  expect(forkUpdate.sections).toEqual({ "zpi.agents": "AGENT_TWO", "zpi.memory": null });
  const boundary = restored.appendMessage({ role: "user", content: "next", timestamp: 2 });
  appendUpdate(restored, { "zpi.base": "BASE_RULES" });
  restored.appendCompaction("second summary", boundary);
  const after = restored.buildSessionContext().messages;
  expect(getCurrentSystemPrompt(after)).toBe("BASE\n\nBASE_RULES\n\nEXTERNAL_NOTE");
  expect(after.at(-1)).toMatchObject({ sections: { "zpi.agents": null, "zpi.memory": null } });
  expect(contextUpdate(after, { "zpi.base": "BASE_RULES" })).toBeUndefined();
  expect(getCurrentSystemPrompt(fork.buildSessionContext().messages)).toContain("AGENT_TWO");
});
