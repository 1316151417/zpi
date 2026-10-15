import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { reduceSession } from "zpi-ui";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

test.each([false, true])(
  "editing removes the accepted recovery input from snapshots and events (queued follow-up: %s)",
  async (withFollowUp) => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "waiting" }));
    });
    const id = f.host.createSession(f.a.id).id;
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
  const task = f.host.createSession(f.a.id);
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
  await f.host.close();
  const reopened = new SessionHost(f.dir, f.settings, f.dir);
  await reopened.init();
  cleanup.push(() => reopened.close());
  expect(reopened.getSessionSnapshot(task.id).view.queue).toMatchObject({
    autoDrain: false,
    items: [{ text: "replacement never lost", state: "queued" }],
  });
  expect(f.server.requests).toHaveLength(1);
});
