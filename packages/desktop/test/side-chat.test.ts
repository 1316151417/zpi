import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { SessionManager } from "zpi-coding-agent";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

for (const boundaryType of ["message", "run", "streaming-tools"] as const) {
  it(`inherits compacted context with a ${boundaryType} boundary without inheriting the timeline`, async () => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "retained answer" }));
      done(response);
    });
    const parent = f.host.createSession(f.a.id);
    await f.host.startRun({ sessionId: parent.id, text: "retained question" });
    await f.host.activeRuns.get(parent.id)?.done;
    await f.host.close();
    const path = join(f.dir, "agent", "sessions", f.a.id, `${parent.id}.jsonl`);
    const manager = SessionManager.open(path);
    const boundary = manager
      .getEntries()
      .find((entry) =>
        boundaryType === "message"
          ? entry.type === "message" && entry.message.role === "user"
          : entry.type === "custom" && entry.customType === "zpi.run",
      );
    if (!boundary) throw new Error("Missing boundary fixture");
    // Streaming journals can also be the first kept entry in real desktop transcripts.
    if (boundaryType === "streaming-tools") {
      manager.replaceEntries(
        manager
          .getEntries()
          .map((entry) =>
            entry.id === boundary.id
              ? { ...entry, type: "custom", customType: "zpi.streaming_tools", data: undefined }
              : entry,
          ),
      );
    }
    const firstKept =
      boundaryType === "streaming-tools"
        ? manager
            .getEntries()
            .find((entry) => entry.type === "custom" && entry.customType === "zpi.streaming_tools")
        : boundary;
    if (!firstKept) throw new Error("Missing kept entry");
    manager.appendCompaction("earlier decisions", firstKept.id);
    manager.appendCompaction("updated earlier decisions", firstKept.id);
    const expected = manager.buildSessionContext().messages;
    const original = await readFile(path, "utf8");
    const host = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
    await host.init();
    cleanup.push(() => host.close());
    const child = await host.createSideChat(parent.id);
    const childPath = join(f.dir, "agent", "sessions", f.a.id, `${child.id}.jsonl`);
    expect(SessionManager.open(childPath).buildSessionContext().messages.slice(0, -1)).toEqual(expected);
    expect(host.getSessionSnapshot(child.id).view.runs).toHaveLength(0);
    expect(host.getHistoryPage(child.id, 0).view.runs).toHaveLength(0);
    await host.startRun({ sessionId: child.id, text: "explain decisions" });
    await host.activeRuns.get(child.id)?.done;
    expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("updated earlier decisions");
    expect(JSON.stringify(f.server.requests.at(-1)?.messages)).toContain("retained question");
    expect(host.getSessionSnapshot(child.id).view.runs.map((run) => run.userMessage)).toEqual([
      "explain decisions",
    ]);
    expect(await readFile(path, "utf8")).toBe(original);
  });
}

it("opens independent hidden chats with inherited context and an empty timeline, retaining isolation after restart", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "parent answer" }));
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "parent question" });
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.setSessionSelection(parent.id, { provider: "custom", modelId: "fake", reasoning: "high" });
  const path = join(f.dir, "agent", "sessions", f.a.id, `${parent.id}.jsonl`);
  const original = await readFile(path, "utf8");
  const child = await f.host.createSideChat(parent.id);
  const sibling = await f.host.createSideChat(parent.id);
  expect(child.id).not.toBe(sibling.id);
  expect(child.parentSessionId).toBe(parent.id);
  expect(f.host.getSessionSnapshot(child.id).view.controls?.selection?.reasoning).toBe("none");
  expect(f.host.getSessionSnapshot(parent.id).view.controls?.selection?.reasoning).toBe("high");
  expect(f.host.listRecentSessions().map((s) => s.id)).toEqual([parent.id]);
  expect(f.host.getSessionSnapshot(child.id).view.runs).toHaveLength(0);
  expect(f.host.getHistoryPage(child.id, 0).view.runs).toHaveLength(0);
  await f.host.startRun({ sessionId: child.id, text: "explain" });
  await f.host.activeRuns.get(child.id)?.done;
  const messages = JSON.stringify(f.server.requests.at(-1)?.messages);
  expect(messages).toContain("parent question");
  expect(messages).toContain("parent answer");
  expect(messages).toContain("Do not continue the parent's active work");
  expect(f.host.getSessionSnapshot(child.id).view.runs.map((r) => r.userMessage)).toEqual(["explain"]);
  expect(await readFile(path, "utf8")).toBe(original);
  await expect(
    f.host.forkSession(child.id, f.host.getSessionSnapshot(child.id).view.runs[0].runId),
  ).rejects.toThrow("不支持分叉");
  await f.host.close();
  const restored = new SessionHost(f.dir, f.settings, f.dir, undefined, undefined);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.listRecentSessions().map((s) => s.id)).toEqual([parent.id]);
  expect(restored.getSessionSnapshot(child.id).view.runs.map((r) => r.userMessage)).toEqual(["explain"]);
});

it("copies the committed active user input without partial assistant output and stops only the closed side chat", async () => {
  const parentStarted = deferred();
  const parentRelease = deferred();
  const childStarted = deferred();
  const childRelease = deferred();
  const f = await fixture(async (_, response, index) => {
    if (index === 0) {
      send(response, chunk({ content: "partial parent" }));
      parentStarted.resolve();
      await parentRelease.promise;
    } else {
      send(response, chunk({ content: "partial child" }));
      childStarted.resolve();
      await childRelease.promise;
    }
    done(response);
  });
  const parent = f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: parent.id, text: "active parent input" });
  await parentStarted.promise;
  const child = await f.host.createSideChat(parent.id);
  await f.host.startRun({ sessionId: child.id, text: "child input" });
  await childStarted.promise;
  const messages = JSON.stringify(f.server.requests[1].messages);
  expect(messages).toContain("active parent input");
  expect(messages).not.toContain("partial parent");
  await f.host.closeSideChat(child.id);
  expect(f.host.activeRuns.has(child.id)).toBe(false);
  expect(f.host.activeRuns.has(parent.id)).toBe(true);
  parentRelease.resolve();
  childRelease.resolve();
  await f.host.activeRuns.get(parent.id)?.done;
  await f.host.deleteSession(parent.id);
  expect(() => f.host.getSessionSnapshot(child.id)).toThrow("不存在");
});
