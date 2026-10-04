import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { createAgentSession, ModelRuntime, SessionManager } from "zpi-coding-agent";
import { demoServer, fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import { cleanup, directory } from "./helpers/session-fixture.ts";

it("bad tail is backed up, middle damage fails, unpaired call recovers without executing", async () => {
  const cwd = await directory();
  const m = SessionManager.create(cwd, cwd);
  m.appendMessage({
    role: "assistant",
    content: [{ type: "toolCall", id: "old", name: "write", arguments: { path: "danger", content: "bad" } }],
    ...fakeModel("http://localhost"),
    model: "fake",
    timestamp: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
  });
  const file = m.getSessionFile() as string;
  await writeFile(file, `${await readFile(file, "utf8")}{"type":`);
  const reopened = SessionManager.open(file);
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", { models: [fakeConfig("http://localhost")], apiKey: "local" });
  const { session } = await createAgentSession({
    userSkillPaths: [],
    modelRuntime: runtime,
    sessionManager: reopened,
  });
  expect(session.messages.find((m) => m.role === "toolResult")).toMatchObject({
    role: "toolResult",
    toolCallId: "old",
    isError: true,
  });
  await expect(readFile(join(cwd, "danger"))).rejects.toThrow();
  session.dispose();
  await writeFile(file, `${await readFile(file, "utf8")}bad\n{}\n`);
  expect(() => SessionManager.open(file)).toThrow("Corrupt");
});

it("storage failure rejects prompt, settles once, blocks further runs", async () => {
  const cwd = await directory();
  const s = await demoServer();
  cleanup.push(s.close);
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", { models: [fakeConfig(s.url)], baseUrl: s.url, apiKey: "local" });
  const m = SessionManager.create(cwd, join(cwd, "sessions"));
  const { session } = await createAgentSession({
    userSkillPaths: [],
    modelRuntime: runtime,
    sessionManager: m,
  });
  let settled = 0;
  session.subscribe((e) => {
    if (e.type === "agent_settled") settled++;
  });
  await rm(join(cwd, "sessions"), { recursive: true });
  await expect(session.prompt("go")).rejects.toThrow("storage");
  expect(settled).toBe(1);
  expect(session.isIdle).toBe(true);
  await expect(session.prompt("again")).rejects.toThrow("storage");
});
