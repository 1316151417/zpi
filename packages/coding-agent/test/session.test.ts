import { createAgentSession, ModelRuntime, SessionManager } from "ZPI-coding-agent";
import { randomUUID } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { demoServer, fakeConfig } from "../../../tests/fake-server.ts";
import { cleanup, directory } from "./helpers/session-fixture.ts";

it("SDK read/write/edit/bash loop persists, reopens and continues", async () => {
  const cwd = await directory();
  await writeFile(join(cwd, "README.md"), "# Temporary project");
  const s = await demoServer();
  cleanup.push(s.close);
  const runtime = await ModelRuntime.create();
  runtime.registerProvider("fake", { baseUrl: s.url, models: [fakeConfig(s.url)], apiKey: "local" });
  const manager = SessionManager.create(cwd, join(cwd, "sessions"));
  const stopMutating = manager.subscribeEntries((entry) => {
    entry.id = "mutated-observer-copy";
    if (entry.type === "message" && entry.message.role === "user") entry.message.content = "mutated";
  });
  const stopChecking = manager.subscribeEntries((entry) => {
    expect(entry.id).toBe(manager.getLastEntry()?.id);
  });
  const { session } = await createAgentSession({
    userSkillPaths: [],
    cwd,
    agentDir: join(cwd, "agent"),
    modelRuntime: runtime,
    sessionManager: manager,
  });
  let settled = 0;
  session.subscribe((e) => {
    if (e.type === "agent_settled") settled++;
  });
  await session.prompt("go");
  expect(settled).toBe(1);
  expect(manager.buildSessionContext().messages).toContainEqual(
    expect.objectContaining({ role: "user", content: "go" }),
  );
  stopMutating();
  stopChecking();
  expect(await readFile(join(cwd, "demo.txt"), "utf8")).toBe("ZPI\n");
  expect(session.messages.filter((m) => m.role === "toolResult")).toHaveLength(4);
  session.dispose();
  // Old goal records remain readable, but cannot reactivate an automatic prompt loop.
  const file = manager.getSessionFile() as string;
  manager.appendMessage({
    role: "system",
    content: "",
    sections: { "ZPI.goal": "OBSOLETE GOAL INSTRUCTION" },
    timestamp: Date.now(),
  });
  await appendFile(
    file,
    `${JSON.stringify({
      type: "goal_change",
      id: randomUUID(),
      parentId: manager.getEntries().at(-1)?.id,
      timestamp: new Date().toISOString(),
      goal: { text: "LEGACY TARGET", status: "active", updatedAt: Date.now() },
    })}\n`,
  );
  const original = await readFile(file, "utf8");
  const reopened = SessionManager.open(file);
  expect(await readFile(file, "utf8")).toBe(original);
  expect(reopened.getEntries().at(-1)?.type).toBe("goal_change");
  expect(reopened.buildSessionContext()).not.toHaveProperty("goal");
  const restored = await createAgentSession({
    userSkillPaths: [],
    modelRuntime: runtime,
    sessionManager: reopened,
    agentDir: join(cwd, "agent"),
  });
  const requests = s.requests.length;
  await restored.session.prompt("continue");
  expect(s.requests.length).toBe(requests + 1);
  expect(JSON.stringify(s.requests.at(-1))).not.toMatch(/OBSOLETE GOAL INSTRUCTION|LEGACY TARGET/);
  expect((await readFile(file, "utf8")).startsWith(original)).toBe(true);
  expect(s.requests.at(-1)?.messages).toEqual(
    expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "call-3" })]),
  );
  expect(restored.session.messages.filter((m) => m.role === "system")).toHaveLength(2);
  restored.session.dispose();
});
