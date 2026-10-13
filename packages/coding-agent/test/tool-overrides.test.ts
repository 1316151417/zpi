import { Type } from "typebox";
import { expect, test } from "vitest";
import { createAgentSession, ModelRuntime, SessionManager, type ToolDefinition } from "zpi-coding-agent";
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
