import { createAgentSession, ModelRuntime, SessionManager } from "ZPI-coding-agent";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { demoServer, fakeConfig, fakeModel } from "../../../tests/fake-server.ts";
import { cleanup, directory } from "./helpers/session-fixture.ts";

it("legacy brand names restore metadata and system sections without rewriting the transcript", async () => {
  const cwd = await directory();
  const manager = SessionManager.create(cwd, cwd);
  manager.appendCustomEntry("ZPI.title", { state: "manual" });
  manager.appendMessage({
    role: "system",
    content: "",
    sections: { "ZPI.instructions": "old instructions", "external.note": "unchanged" },
    timestamp: 1,
  });
  const file = manager.getSessionFile() as string;
  const old = (await readFile(file, "utf8")).replaceAll("ZPI", "ZPI".toLowerCase());
  await writeFile(file, old);
  const restored = SessionManager.open(file);
  expect(restored.getEntries()[0]).toMatchObject({ customType: "ZPI.title" });
  expect(restored.getEntries()[1]).toMatchObject({
    message: { sections: { "ZPI.instructions": "old instructions", "external.note": "unchanged" } },
  });
  expect(await readFile(file, "utf8")).toBe(old);
  restored.appendCustomEntry("ZPI.attention", { unreadAt: 1 });
  expect(SessionManager.open(file).getEntries().at(-1)).toMatchObject({ customType: "ZPI.attention" });
});

it("transcript replacement rekeys compaction boundaries, persists a valid chain and rejects invalid replacement atomically", async () => {
  const cwd = await directory();
  const source = SessionManager.inMemory(cwd);
  source.appendMessage({ role: "user", content: "compacted", timestamp: 1 });
  const kept = source.appendMessage({ role: "user", content: "kept", timestamp: 2 });
  source.appendCompaction("summary", kept);
  const target = SessionManager.create(cwd, join(cwd, "sessions"));
  target.replaceEntries(source.getEntries());
  expect(target.getEntries().map((entry) => entry.id)).not.toContain(kept);
  const file = target.getSessionFile() as string;
  const restored = SessionManager.open(file);
  expect(restored.buildSessionContext()).toEqual(source.buildSessionContext());
  const before = await readFile(file, "utf8"),
    entries = target.getEntries();
  expect(() => target.replaceEntries([entries[0], entries[0]])).toThrow("Duplicate");
  expect(() => target.replaceEntries(entries.slice(-1))).toThrow("boundary");
  expect(await readFile(file, "utf8")).toBe(before);
  expect(target.getEntries()).toEqual(entries);
});

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
