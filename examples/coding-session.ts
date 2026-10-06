import { createAgentSession, ModelRuntime, SessionManager } from "ZPI-coding-agent";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { demoServer, fakeConfig } from "../tests/fake-server.ts";

const cwd = await mkdtemp(join(tmpdir(), "ZPI-example-"));
await writeFile(join(cwd, "README.md"), "# Demo project\nAll tools run inside this temporary directory.\n");
const server = await demoServer();
const runtime = await ModelRuntime.create();
runtime.registerProvider("fake", {
  baseUrl: server.url,
  apiKey: "local-demo",
  models: [fakeConfig(server.url)],
});
const manager = SessionManager.create(cwd, join(cwd, "sessions"));
const { session } = await createAgentSession({
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
