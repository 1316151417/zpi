import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import {
  createAgentSession,
  createBashToolDefinition,
  ModelRuntime,
  SessionManager,
  type ToolDefinition,
} from "zpi-coding-agent";
import { demoServer, fakeConfig } from "../tests/fake-server.ts";

const cwd = await mkdtemp(join(tmpdir(), "zpi-example-"));
await writeFile(join(cwd, "README.md"), "# Demo project\nAll tools run inside this temporary directory.\n");
const server = await demoServer();
const runtime = await ModelRuntime.create();
runtime.registerProvider("fake", {
  baseUrl: server.url,
  apiKey: "local-demo",
  models: [fakeConfig(server.url)],
});
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
const workspaceInfo: ToolDefinition = {
  name: "workspace_info",
  label: "Workspace info",
  description: "Return the current working directory",
  parameters: Type.Object({}),
  async execute(_id, _params, _signal, _update, context) {
    return { content: [{ type: "text", text: context.cwd }], details: undefined };
  },
};
// Reuse the same additions when reopening; callbacks may supply refreshed instructions.
const extensions = {
  customTools: [workspaceInfo],
  toolOverrides: [createBashToolDefinition(cwd)],
  customInstructions: ["Keep the example changes small and explain the verification result."],
};
const { session } = await createAgentSession({
  ...extensions,
  cwd,
  agentDir: join(cwd, "agent"),
  modelRuntime: runtime,
  sessionManager: manager,
});
session.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta")
    process.stdout.write(event.assistantMessageEvent.delta);
  if (event.type === "tool_execution_end")
    console.log(`\n${event.toolName}: ${event.isError ? "error" : "ok"}`);
});
try {
  await session.prompt("读取 README，然后 write、edit 和 bash 验证。");
  console.log("\nFile:", await readFile(join(cwd, "demo.txt"), "utf8"));
  session.dispose();
  const restored = await createAgentSession({
    ...extensions,
    modelRuntime: runtime,
    sessionManager: SessionManager.open(manager.getSessionFile() as string),
    agentDir: join(cwd, "agent"),
  });
  try {
    await restored.session.prompt("继续先前对话");
    console.log("Restored messages:", restored.session.messages.length);
  } finally {
    await restored.session.abort();
    restored.session.dispose();
  }
  console.log("Saved example:", cwd);
} finally {
  await session.abort();
  session.dispose();
  await server.close();
}
