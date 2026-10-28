import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import type { DesktopEventEnvelope } from "zpi-ui";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("manual model retry targets only its live session and run without stopping concurrent work", async () => {
  const seen = new Map<string, ReturnType<typeof deferred>>([
    ["recover", deferred()],
    ["other", deferred()],
    ["new", deferred()],
  ]);
  const requests = new Map<string, number>();
  const f = await fixture((body, response) => {
    const rows = body.messages as unknown as { role: string; content: string }[];
    const text = rows.findLast((row) => row.role === "user")?.content ?? "";
    const count = (requests.get(text) ?? 0) + 1;
    requests.set(text, count);
    response.flushHeaders();
    seen.get(text)?.resolve(undefined);
    if (text === "recover" && count === 2) {
      send(response, chunk({ content: "recovered answer" }));
      done(response);
    }
  });
  const first = await f.host.createSession(f.a.id);
  const other = await f.host.createSession(f.b.id);
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: "missing" })).toBe(false);
  const run = await f.host.startRun({ sessionId: first.id, text: "recover" });
  const concurrent = await f.host.startRun({ sessionId: other.id, text: "other" });
  await Promise.all([seen.get("recover")?.promise, seen.get("other")?.promise]);
  const finished = f.host.activeRuns.get(first.id)?.done;
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: concurrent.runId })).toBe(false);
  expect(f.host.retryModelRequest({ sessionId: "missing", runId: run.runId })).toBe(false);
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: run.runId })).toBe(true);
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: run.runId })).toBe(false);
  await finished;
  expect(f.host.getSessionSnapshot(first.id).view.runs[0]).toMatchObject({
    status: "completed",
    modelWait: null,
  });
  expect(JSON.stringify(f.host.getSessionSnapshot(first.id).view)).toContain("recovered answer");
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: run.runId })).toBe(false);
  expect(f.host.getSessionSnapshot(other.id).view.runs[0].status).toBe("running");
  expect(requests.get("other")).toBe(1);
  const replacement = await f.host.startRun({ sessionId: first.id, text: "new" });
  await seen.get("new")?.promise;
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: run.runId })).toBe(false);
  const stopping = f.host.abortRun({ sessionId: first.id, runId: replacement.runId });
  expect(f.host.retryModelRequest({ sessionId: first.id, runId: replacement.runId })).toBe(false);
  await stopping;
  await f.host.abortRun({ sessionId: other.id, runId: concurrent.runId });
  expect(requests).toEqual(
    new Map([
      ["recover", 2],
      ["other", 1],
      ["new", 1],
    ]),
  );
});

it("same-project and cross-project sessions stream concurrently; busy, stale cancel and snapshot identity", async () => {
  const seen = deferred();
  let arrived = 0;
  const release = deferred();
  const { host, a, b, dir, settings } = await fixture(async (_, response) => {
    send(response, chunk({ content: "first" }));
    if (++arrived === 3) seen.resolve();
    await release.promise;
    if (!response.destroyed) {
      send(response, chunk({ content: " second" }));
      done(response);
    }
  });
  const events: DesktopEventEnvelope[] = [];
  const rendered = deferred();
  const observed = new Set<string>();
  host.subscribe((e) => {
    events.push(e);
    if (e.event.type === "block_delta") {
      observed.add(e.sessionId);
      if (observed.size === 3) rendered.resolve();
    }
  });
  const sessions = [
    await host.createSession(a.id),
    await host.createSession(a.id),
    await host.createSession(b.id),
  ];
  host.activateSession(sessions[2].id);
  const ack = await Promise.all(sessions.map((s) => host.startRun({ sessionId: s.id, text: s.id })));
  await seen.promise;
  await rendered.promise;
  expect(host.activeRuns.size).toBe(3);
  await expect(host.startRun({ sessionId: sessions[0].id, text: "again" })).rejects.toThrow("busy");
  const snap = host.getSessionSnapshot(sessions[1].id);
  expect(snap.view.runs[0].orderedBlocks[0]).toMatchObject({ text: "first" });
  expect(events.filter((e) => e.sessionId === sessions[1].id).at(-1)?.seq).toBe(snap.seq);
  await host.abortRun({ sessionId: sessions[0].id, runId: ack[0].runId });
  expect(host.activeRuns.size).toBe(2);
  expect(host.getSessionSnapshot(sessions[0].id).view.runs[0].status).toBe("aborted");
  release.resolve();
  await Promise.all([...host.activeRuns.values()].map((r) => r.done));
  expect(host.getSessionSnapshot(sessions[1].id).view.runs[0].status).toBe("completed");
  const unread = host.listRecentSessions().find((r) => r.id === sessions[1].id)?.unreadAt;
  expect(unread).toEqual(expect.any(Number));
  expect(host.listRecentSessions().find((r) => r.id === sessions[0].id)?.unreadAt).toBeUndefined();
  expect(host.listRecentSessions().find((r) => r.id === sessions[2].id)?.unreadAt).toBeUndefined();
  const newer = await host.startRun({ sessionId: sessions[0].id, text: "next" });
  await expect(host.abortRun({ sessionId: sessions[0].id, runId: ack[0].runId })).rejects.toThrow(
    "not_found",
  );
  expect(newer.runId).not.toBe(ack[0].runId);
  await Promise.all([...host.activeRuns.values()].map((r) => r.done));
  const settled = events.filter((e) => e.event.type === "settled");
  expect(new Set(settled.map((e) => e.runId)).size).toBe(settled.length);
  await host.close();
  const restored = new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined);
  await restored.init();
  cleanup.push(() => restored.close());
  expect(restored.listRecentSessions().find((r) => r.id === sessions[1].id)?.unreadAt).toBe(unread);
  const updatedAt = restored.listRecentSessions().find((r) => r.id === sessions[1].id)?.updatedAt;
  expect(restored.activateSession(sessions[1].id)).toMatchObject({ unreadAt: undefined, updatedAt });
  await restored.close();
  const readAgain = new SessionHost(dir, settings, join(dir, "agent"), undefined, undefined);
  await readAgain.init();
  cleanup.push(() => readAgain.close());
  expect(readAgain.listRecentSessions().find((r) => r.id === sessions[1].id)?.unreadAt).toBeUndefined();
});

it("failure and storage error affect only their session; closing aborts all", async () => {
  const first = deferred();
  const f = await fixture(async (body, response) => {
    const ms = body.messages as unknown as { role: string; content: string }[];
    const t = ms.find((m) => m.role === "user")?.content;
    send(response, chunk({ content: "live" }));
    if (t === "fail") {
      // 先让正文到达客户端，验证断流恢复上限，而不是请求建立前的指数退避。
      await new Promise((resolve) => setTimeout(resolve, 10));
      response.destroy();
    } else first.resolve();
  });
  const settled = new Map<string, string>();
  f.host.subscribe(({ sessionId, event }) => {
    if (event.type === "settled") settled.set(sessionId, event.status);
  });
  // 固定重试预算与退避，验证断流恢复上限本身，而不依赖默认 agent 重试次数。
  await writeFile(
    join(f.dir, "agent", "settings.json"),
    JSON.stringify({ retry: { maxRetries: 3, baseDelayMs: 0 } }),
  );
  const a = await f.host.createSession(f.a.id),
    b = await f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: a.id, text: "fail" });
  await f.host.startRun({ sessionId: b.id, text: "hang" });
  await first.promise;
  await f.host.activeRuns.get(a.id)?.done;
  await f.host.close();
  expect(f.host.activeRuns.size).toBe(0);
  expect(settled.get(a.id)).toBe("error");
  expect(settled.get(b.id)).toBe("aborted");
});

it("credential values never leave settings reader or metadata and hidden projects retain history", async () => {
  const f = await fixture((_, r) => {
    send(r, chunk({ content: "ok" }));
    done(r);
  });
  const session = await f.host.createSession(f.a.id);
  await f.host.startRun({ sessionId: session.id, text: "hello" });
  await Promise.all([...f.host.activeRuns.values()].map((r) => r.done));
  const saved = JSON.stringify(f.settings.state.getSetting("app"));
  const record = await readFile(join(f.dir, "agent", "sessions", f.a.id, `${session.id}.jsonl`), "utf8");
  expect(saved + record + JSON.stringify(f.settings.get())).not.toContain("secret-host");
  expect(saved + record + JSON.stringify(f.settings.get())).not.toContain("secret-header");
  f.host.removeProject(f.a.id);
  expect(f.host.listProjects()).not.toContainEqual(expect.objectContaining({ id: f.a.id }));
  const restored = await f.host.addProject(f.a.path);
  expect(restored.id).toBe(f.a.id);
  expect(f.host.listSessions(f.a.id)[0].id).toBe(session.id);
  const restart = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined);
  await restart.init();
  expect(restart.getSessionSnapshot(session.id).view.runs[0].status).toBe("completed");
  expect(restart.activeRuns.size).toBe(0);
});
