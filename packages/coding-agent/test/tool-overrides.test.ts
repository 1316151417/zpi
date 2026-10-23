import { Type } from "typebox";
import { expect, test } from "vitest";
import {
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "zpi-coding-agent";
import { fakeConfig } from "../../../tests/fake-server.ts";
import { directory } from "./helpers/session-fixture.ts";

test("explicit built-in overrides receive session context without removing other tools or permitting duplicate names", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:1",
    models: [fakeConfig("")],
    apiKey: "local",
  });
  const override: ToolDefinition = {
    name: "bash",
    label: "Custom shell",
    description: "Custom shell",
    parameters: Type.Object({ command: Type.String() }),
    execute: async (_id, _params, _signal, _update, context) => ({
      content: [{ type: "text", text: context.cwd }],
      details: undefined,
    }),
  };
  const options = {
    cwd,
    agentDir: cwd,
    homeDir: cwd,
    modelRuntime: runtime,
    sessionManager: SessionManager.inMemory(cwd),
  };
  const { session } = await createAgentSession({ ...options, toolOverrides: [override] });
  try {
    expect(session.state.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
    const bash = session.state.tools.find((tool) => tool.name === "bash");
    if (!bash) throw new Error("Missing shell");
    expect(await bash.execute("call", { command: "test" })).toMatchObject({ content: [{ text: cwd }] });
    await expect(
      createAgentSession({ ...options, toolOverrides: [{ ...override, name: "missing" }] }),
    ).rejects.toThrow("Unknown built-in");
    await expect(createAgentSession({ ...options, toolOverrides: [override, override] })).rejects.toThrow(
      "Duplicate tool overrides",
    );
    await expect(createAgentSession({ ...options, customTools: [override] })).rejects.toThrow(
      "Duplicate tool names",
    );
  } finally {
    session.dispose();
  }
});

test("public built-in factories register as overrides and preserve standalone execution", async () => {
  const cwd = await directory();
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", {
    baseUrl: "http://127.0.0.1:1",
    models: [fakeConfig("")],
    apiKey: "local",
  });
  const definitions = [
    createReadToolDefinition(cwd),
    createBashToolDefinition(cwd),
    createEditToolDefinition(cwd),
    createWriteToolDefinition(cwd),
  ];
  const manager = SessionManager.inMemory(cwd);
  const { session } = await createAgentSession({
    cwd,
    agentDir: cwd,
    homeDir: cwd,
    modelRuntime: runtime,
    sessionManager: manager,
    toolOverrides: definitions,
  });
  try {
    expect(session.state.tools.map((tool) => tool.name)).toEqual(["read", "bash", "edit", "write"]);
    const tool = (name: string) => {
      const tool = session.state.tools.find((tool) => tool.name === name);
      if (!tool) throw new Error(`Missing tool: ${name}`);
      return tool;
    };
    await tool("write").execute("write", { path: "example.txt", content: "before" });
    await tool("edit").execute("edit", {
      path: "example.txt",
      edits: [{ oldText: "before", newText: "after" }],
    });
    expect((await tool("read").execute("read", { path: "example.txt" })).content).toEqual([
      { type: "text", text: "after" },
    ]);
    const bash = await tool("bash").execute("bash", { command: 'printf "%s" "$ZPI_SESSION_ID"' });
    expect(bash.content).toEqual([{ type: "text", text: manager.getSessionId() }]);
    // Factories are also usable directly without a session or execution context.
    expect(
      (await createReadToolDefinition(cwd).execute("standalone", { path: "example.txt" })).content,
    ).toEqual([{ type: "text", text: "after" }]);
  } finally {
    session.dispose();
  }
});
