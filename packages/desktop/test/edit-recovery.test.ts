import { readFile } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { chunk, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

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
  const fail = vi.spyOn(f.host, "startRun").mockRejectedValueOnce(new Error("crash before acceptance"));
  await expect(
    f.host.editUserMessage(task.id, run.runId, { text: "replacement never lost" }),
  ).rejects.toThrow("crash before acceptance");
  fail.mockRestore();
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
