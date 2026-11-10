import { readFile } from "node:fs/promises";
import { reduceSession } from "@zpi-dev/ui";
import { expect, test, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

test.each([false, true])(
  "a rejected compact edit preserves history and queue (active: %s)",
  async (active) => {
    const f = await fixture((_, response) => {
      if (active) response.flushHeaders();
      else {
        send(response, chunk({ content: "original answer" }));
        done(response);
      }
    });
    const session = await f.host.createSession(f.a.id);
    const run = await f.host.startRun({ sessionId: session.id, text: "original input" });
    if (!active) await f.host.activeRuns.get(session.id)?.done;
    await expect.poll(() => f.server.requests.length).toBe(1);
    const path = f.host.sessionPath(session.id);
    const before = await readFile(path);
    const queue = f.host.inputQueue.get(session.id);
    const totals = f.settings.state.getTask(session.id)?.modelPerformanceTotals;
    await expect(f.host.editUserMessage(session.id, run.runId, { text: "/compact" })).rejects.toThrow(
      "历史消息不能替换为 /compact",
    );
    expect(f.host.sessionPath(session.id)).toBe(path);
    expect(await readFile(path)).toEqual(before);
    expect(f.host.getSessionSnapshot(session.id).view.runs.map((item) => item.userMessage)).toEqual([
      "original input",
    ]);
    expect(f.host.inputQueue.get(session.id)).toEqual(queue);
    expect(f.settings.state.getTask(session.id)?.modelPerformanceTotals).toEqual(totals);
    expect(f.host.activeRuns.has(session.id)).toBe(active);
    expect(f.server.requests).toHaveLength(1);
  },
);

test.each([0, 1])(
  "editing recomputes counts and usage with %s retained turns, including side chats and restart",
  async (retained) => {
    const f = await fixture((body, response) => {
      const discarded = JSON.stringify(body.messages).includes("discarded");
      const scale = discarded ? 10 : 1;
      send(response, chunk({ content: "answer" }));
      send(response, {
        ...chunk({}),
        choices: [],
        usage: {
          prompt_tokens: 100 * scale,
          completion_tokens: 10 * scale,
          total_tokens: 110 * scale,
          prompt_tokens_details: { cached_tokens: 20 * scale },
        },
      });
      done(response);
    });
    const task = await f.host.createSession(f.a.id);
    if (retained) {
      await f.host.startRun({ sessionId: task.id, text: "retained question" });
      await f.host.activeRuns.get(task.id)?.done;
    }
    let run = await f.host.startRun({ sessionId: task.id, text: "discarded question" });
    await f.host.activeRuns.get(task.id)?.done;
    expect(f.host.getSessionSnapshot(task.id).view.modelPerformance).toMatchObject({
      turns: retained + 1,
      steps: retained + 1,
      inputTokens: 80 * (retained + 10),
    });
    const expected = {
      turns: retained + 1,
      steps: retained + 1,
      inputTokens: 80 * (retained + 1),
      outputTokens: 10 * (retained + 1),
      cacheReadTokens: 20 * (retained + 1),
    };
    for (const text of ["replacement question", "edited again"]) {
      await f.host.editUserMessage(task.id, run.runId, { text });
      await f.host.activeRuns.get(task.id)?.done;
      const view = f.host.getSessionSnapshot(task.id).view;
      expect(view.runs.map((item) => item.userMessage)).toEqual([
        ...(retained ? ["retained question"] : []),
        text,
      ]);
      expect(view.modelPerformance).toMatchObject(expected);
      expect(f.settings.state.getTask(task.id)?.modelPerformanceTotals).toMatchObject(expected);
      const latest = view.runs.at(-1);
      if (!latest) throw new Error("Missing replacement run");
      run = { runId: latest.runId };
    }
    const child = await f.host.createSideChat(task.id);
    expect(f.host.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject(expected);
    await f.host.close();
    const reopened = new SessionHost(f.dir, f.settings, f.dir);
    cleanup.push(() => reopened.close());
    await reopened.init();
    expect(reopened.getSessionSnapshot(task.id).view.modelPerformance).toMatchObject(expected);
    expect(reopened.getSessionSnapshot(child.id).view.modelPerformance).toMatchObject(expected);
    await reopened.startRun({ sessionId: task.id, text: "next question" });
    await reopened.activeRuns.get(task.id)?.done;
    expect(reopened.getSessionSnapshot(task.id).view.modelPerformance).toMatchObject({
      turns: retained + 2,
      steps: retained + 2,
      inputTokens: 80 * (retained + 2),
      outputTokens: 10 * (retained + 2),
      cacheReadTokens: 20 * (retained + 2),
    });
  },
);

test.each([false, true])(
  "editing removes the accepted recovery input from snapshots and events (queued follow-up: %s)",
  async (withFollowUp) => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "waiting" }));
    });
    const id = (await f.host.createSession(f.a.id)).id;
    const run = await f.host.startRun({ sessionId: id, text: "original" });
    if (withFollowUp) await f.host.submitInput({ sessionId: id, text: "follow-up" });
    let projected = f.host.getSessionSnapshot(id).view;
    const unsubscribe = f.host.subscribe((event) => {
      projected = reduceSession(projected, event);
    });
    try {
      const edited = await f.host.editUserMessage(id, run.runId, { text: "replacement" });
      if (!("view" in edited)) throw new Error("Unexpected edit conflicts");
      const expected = withFollowUp ? ["follow-up"] : [];
      expect(edited.view.queue?.items.map((item) => item.text)).toEqual(expected);
      expect(projected.queue).toEqual(edited.view.queue);
      expect(f.host.inputQueue.get(id)).toEqual(edited.view.queue);
      expect(f.settings.state.getQueue(id)?.items.map((item) => item.text)).toEqual(expected);
      expect(projected.runs.at(-1)?.userMessage).toBe("replacement");
      if (withFollowUp) {
        expect(projected.queue?.autoDrain).toBe(false);
        const followUp = projected.queue?.items[0];
        if (!followUp) throw new Error("Missing queued follow-up");
        await f.host.inputQueue.remove(id, followUp.id);
        expect(projected.queue?.items).toEqual([]);
      }
    } finally {
      unsubscribe();
    }
  },
);

test("editing keeps the replacement input recoverable if interrupted after history generation commits", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "old answer" }));
    done(response);
  });
  const task = await f.host.createSession(f.a.id);
  const run = await f.host.startRun({ sessionId: task.id, text: "old input" });
  await f.host.activeRuns.get(task.id)?.done;
  const oldPath = f.host.sessionPath(task.id);
  const oldBytes = await readFile(oldPath);
  let projected = f.host.getSessionSnapshot(task.id).view;
  const unsubscribe = f.host.subscribe((event) => {
    projected = reduceSession(projected, event);
  });
  cleanup.push(async () => unsubscribe());
  const fail = vi.spyOn(f.host, "startRun").mockRejectedValueOnce(new Error("crash before acceptance"));
  await expect(
    f.host.editUserMessage(task.id, run.runId, { text: "replacement never lost" }),
  ).rejects.toThrow("crash before acceptance");
  fail.mockRestore();
  expect(projected.queue).toEqual(f.host.inputQueue.get(task.id));
  expect(projected.queue).toMatchObject({
    autoDrain: false,
    items: [{ text: "replacement never lost", state: "queued" }],
  });
  expect(f.host.sessionPath(task.id)).not.toBe(oldPath);
  expect(await readFile(oldPath)).toEqual(oldBytes);
  expect(f.host.getSessionSnapshot(task.id).view.modelPerformance).toEqual({});
  expect(f.settings.state.getTask(task.id)?.modelPerformanceTotals).toMatchObject({ turns: 0, steps: 0 });
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, f.dir);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.getSessionSnapshot(task.id).view.queue).toMatchObject({
    autoDrain: false,
    items: [{ text: "replacement never lost", state: "queued" }],
  });
  expect(reopened.getSessionSnapshot(task.id).view.modelPerformance).toEqual({});
  expect(f.server.requests).toHaveLength(1);
});

test("finishing an edit does not release a newer operation's update lock", async () => {
  const f = await fixture((_, response) => {
    send(response, chunk({ content: "answer" }));
    done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  const run = await f.host.startRun({ sessionId: id, text: "original" });
  await f.host.activeRuns.get(id)?.done;
  const updating = Reflect.get(f.host, "updating") as Set<string>;
  const start = vi.spyOn(f.host, "startRun").mockImplementationOnce(async () => {
    expect(updating.has(id)).toBe(false);
    updating.add(id);
    return { runId: "replacement" };
  });
  try {
    await f.host.editUserMessage(id, run.runId, { text: "replacement" });
    expect(updating.has(id)).toBe(true);
  } finally {
    updating.delete(id);
    start.mockRestore();
  }
});
