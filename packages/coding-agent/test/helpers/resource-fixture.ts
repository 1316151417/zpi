import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { createAgentSession, ModelRuntime, SessionManager } from "zpi-coding-agent";
import { fakeConfig, fakeServer } from "../../../../tests/fake-server.ts";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.allSettled(
    cleanup
      .splice(0)
      .reverse()
      .map((f) => f()),
  );
});
export async function fixture(handler: Parameters<typeof fakeServer>[0]) {
  const dir = await mkdtemp(join(tmpdir(), "zpi-resources-"));
  cleanup.push(() => rm(dir, { recursive: true, force: true }));
  const cwd = join(dir, "project"),
    agentDir = join(dir, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  const server = await fakeServer(handler);
  cleanup.push(server.close);
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", { baseUrl: server.url, apiKey: "", models: [fakeConfig(server.url)] });
  const manager = SessionManager.create(cwd, join(dir, "sessions"));
  const { session } = await createAgentSession({
    userSkillPaths: [],
    cwd,
    agentDir,
    modelRuntime: runtime,
    sessionManager: manager,
  });
  cleanup.push(async () => {
    await session.abort();
    session.dispose();
  });
  return { dir, cwd, agentDir, server, runtime, manager, session };
}
export async function skill(root: string, name: string, description: string, body = "BODY") {
  const dir = join(root, name);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\n${body}`);
}
