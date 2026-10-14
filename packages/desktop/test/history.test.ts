import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { emptyAssistant } from "zpi-ai";
import { SessionManager } from "zpi-coding-agent";
import { mergeHistory } from "zpi-ui";
import { chunk, deferred, done, fakeModel, send } from "../../../tests/fake-server.ts";
import { seedHistory } from "../../../tests/history-fixture.ts";
import { HistoryIndex } from "../src/main/history-index.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { fixture } from "./helpers/host-fixture.ts";
import { cleanup, idle, setup } from "./helpers/session-fixture.ts";

it("includes cache writes in indexed usage and rebuilds indexes with the old denominator", async () => {
  const { host, dir, cwd } = await setup();
  const seed = seedHistory(dir, cwd, 0);
  await host.close();
  const manager = SessionManager.open(seed.file);
  const reply = emptyAssistant(fakeModel(""));
  reply.usageAvailable = reply.cacheUsageAvailable = true;
  reply.usage = { ...reply.usage, input: 10, cacheRead: 100, cacheWrite: 890, totalTokens: 1000 };
  manager.appendMessage(reply);
  const index = new HistoryIndex(seed.file);
  await index.load();
  expect(index.data.cacheRead).toBe(100);
  expect(index.data.cacheInput).toBe(1000);
  await writeFile(`${seed.file}.index.json`, JSON.stringify({ ...index.data, version: 10, cacheInput: 110 }));
  const rebuilt = new HistoryIndex(seed.file);
  await rebuilt.load();
  expect(rebuilt.readBytes).toBeGreaterThan(0);
  expect(rebuilt.data.cacheInput).toBe(1000);
  const cached = new HistoryIndex(seed.file);
  await cached.load();
  expect(cached.readBytes).toBe(0);
  expect(cached.data.cacheRead / cached.data.cacheInput).toBe(0.1);
});

it("legacy tool declarations preserve block identity between streaming and paged history", async () => {
  const release = deferred(),
    streamed = deferred();
  const { host, dir, a, settings } = await fixture(async (_, response) => {
    send(response, chunk({ content: "first" }));
    await release.promise;
    send(response, chunk({ content: " second" }));
    done(response);
  });
  const seed = seedHistory(dir, a.path, 1, { projectId: a.id });
  SessionManager.open(seed.file).appendMessage({ role: "system", content: "legacy", timestamp: Date.now() });
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined);
  await reopened.init();
  cleanup.push(() => reopened.close());
  reopened.subscribe(({ event }) => {
    if (event.type === "block_delta") streamed.resolve();
  });
  try {
    reopened.getSessionSnapshot(seed.id);
    const { runId } = await reopened.startRun({ sessionId: seed.id, text: "continue legacy" });
    await streamed.promise;
    const live = reopened.getSessionSnapshot(seed.id).view;
    const liveBlocks = live.runs.find((run) => run.runId === runId)?.orderedBlocks;
    expect(liveBlocks).toMatchObject([{ messageId: `${runId}:2`, text: "first" }]);
    const messages = SessionManager.open(seed.file)
      .getEntries()
      .filter((entry) => entry.type === "message");
    expect(messages.at(-2)).toMatchObject({ message: { role: "system", toolsAdded: expect.any(Array) } });
    release.resolve();
    await idle(reopened, seed.id);
    const settled = reopened.getSessionSnapshot(seed.id).view;
    const restored = reopened.getHistoryPage(seed.id, 2).view;
    const blocks = (view: typeof live) => view.runs.find((run) => run.runId === runId)?.orderedBlocks;
    expect(blocks(restored)?.map((block) => block.id)).toEqual(blocks(settled)?.map((block) => block.id));
    expect(blocks(mergeHistory(restored, settled))).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it("lowercase transcripts rebuild stale indexes and retain run metadata and paged history", async () => {
  const { host, dir, cwd } = await setup();
  const seed = seedHistory(dir, cwd, 2, { perRun: 2 });
  await host.close();
  const before = new HistoryIndex(seed.file);
  await before.load();
  const original = await readFile(seed.file, "utf8");
  const { stat } = await import("node:fs/promises");
  const fileStat = await stat(seed.file);
  await writeFile(
    `${seed.file}.index.json`,
    JSON.stringify({ ...before.data, version: 5, size: fileStat.size, modified: fileStat.mtimeMs }),
  );
  const restored = new HistoryIndex(seed.file);
  await restored.load();
  expect(restored.readBytes).toBeGreaterThan(0);
  expect(restored.data.header.format).toBe("zpi");
  expect(restored.data.diagnostic).toBeUndefined();
  expect(restored.data.state["zpi.session_meta"]).toMatchObject({ customType: "zpi.session_meta" });
  expect(restored.data.calls).toHaveLength(2);
  expect(restored.page().entries).toEqual(before.page().entries);
  expect(await readFile(seed.file, "utf8")).toBe(original);
});

it("history diagnostics retain the first damaged record's byte offset", async () => {
  const { host, dir, cwd } = await setup();
  const seed = seedHistory(dir, cwd, 1);
  await host.close();
  const original = await readFile(seed.file, "utf8");
  const firstNewline = original.indexOf("\n") + 1;
  const header = original.slice(0, firstNewline);
  const damaged = `${header}{broken\n{also-broken\n${original.slice(firstNewline)}`;
  await writeFile(seed.file, damaged);
  const index = new HistoryIndex(seed.file);
  await index.load();
  expect(index.data.diagnostic).toContain(`Invalid JSONL record at byte ${Buffer.byteLength(header)}:`);
  expect(await readFile(seed.file, "utf8")).toBe(damaged);
});

it("page counts Agent pairs, includes interrupted invocation, and keeps continuation anchor without reducing model history", async () => {
  const { host, dir, cwd, settings, server } = await setup();
  const seed = seedHistory(dir, cwd, 26, { perRun: 13, interrupted: true, outputBytes: 2048 });
  await host.close();
  const reopened = new SessionHost(dir, settings, join(dir, "resources"), cwd, undefined);
  await reopened.init();
  cleanup.push(() => reopened.close());
  const snapshot = reopened.getSessionSnapshot(seed.id);
  expect(snapshot.historyCursor).toBe(15); // ten completed calls plus the incomplete one
  expect(snapshot.view.runs).toHaveLength(1); // eleven calls can belong to one Desktop run
  expect(snapshot.view.runs[0].userMessage).toBe("用户上下文 13");
  expect(snapshot.view.runs[0].orderedBlocks.filter((b) => b.type === "tool")).toHaveLength(11);
  expect(snapshot.view.runs[0].status).toBe("interrupted");
  const older = reopened.getHistoryPage(seed.id, 15);
  expect(older.calls).toBe(10);
  expect(older.cursor).toBe(5);
  expect(older.view.runs.map((r) => r.userMessage)).toEqual(["用户上下文 0", "用户上下文 13"]);
  expect(older.view.runs.flatMap((r) => r.orderedBlocks).filter((b) => b.type === "tool")).toHaveLength(10);
  const index = new HistoryIndex(seed.file);
  await index.load();
  expect(index.readBytes).toBe(0);
  index.page();
  expect(index.readBytes).toBeLessThan((await readFile(seed.file)).byteLength / 2);
  await reopened.startRun({ sessionId: seed.id, text: "模型上下文仍然完整" });
  await idle(reopened, seed.id);
  expect(((server.requests.at(-1)?.messages ?? []) as unknown[]).length).toBeGreaterThan(26 * 3);
});
