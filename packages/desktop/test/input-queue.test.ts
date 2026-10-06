import { buildSelectionPrompt } from "ZPI-ui/selections";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("queued inputs reorder, withdraw, preempt and drain once without entering history early", async () => {
  const release = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: `${user} reply` }));
    if (user === "hold") await release.promise;
    if (!response.destroyed) done(response);
  });
  const session = f.host.createSession(f.a.id),
    id = session.id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  const one = await f.host.submitInput({ sessionId: id, text: "one" });
  const two = await f.host.submitInput({ sessionId: id, text: "two" });
  const three = await f.host.submitInput({ sessionId: id, text: "three" });
  expect(f.host.getSessionSnapshot(id).view.runs.map((r) => r.userMessage)).toEqual(["hold"]);
  await expect(
    f.host.submitInput({ sessionId: id, text: "invalid", fileReferences: ["missing"] }),
  ).rejects.toThrow();
  if (
    !("queueItemId" in one) ||
    !one.queueItemId ||
    !("queueItemId" in two) ||
    !two.queueItemId ||
    !("queueItemId" in three) ||
    !three.queueItemId
  )
    throw new Error("queue ACK");
  await f.host.inputQueue.move(id, three.queueItemId, one.queueItemId);
  await f.host.inputQueue.remove(id, two.queueItemId);
  const edited = await f.host.editQueuedInput(id, one.queueItemId);
  expect(edited.draft.text).toBe("one");
  expect(edited.item.text).toBe("one");
  f.host.saveDraft(id, { ...edited.draft, text: "", selection: [0, 0], revision: edited.draft.revision + 1 });
  await f.host.submitInput({ sessionId: id, text: "one revised" });
  await f.host.inputQueue.sendNow(id, three.queueItemId);
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs.map((r) => [r.userMessage, r.status]))
    .toEqual([
      ["hold", "aborted"],
      ["three", "completed"],
      ["one revised", "completed"],
    ]);
  expect(f.host.getSessionSnapshot(id).view.queue?.items).toHaveLength(0);
  expect(f.server.requests).toHaveLength(3);
  release.resolve();
});

it("stopped queues and image ownership survive restart; errors pause without losing accepted input", async () => {
  const errorGate = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: unknown }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "reply" }));
    if (user === "hold") return;
    if (user === "error") {
      await errorGate.promise;
      send(response, { error: { message: "stream interrupted" } });
      response.end();
      return;
    }
    done(response);
  });
  f.settings.save({
    baseUrl: f.server.url,
    modelId: "fake",
    supportsImages: true,
    reasoning: true,
    compat: { supportsReasoningEffort: true },
    contextWindow: 32768,
    maxTokens: 4096,
  });
  const id = f.host.createSession(f.a.id).id;
  const b = f.host.createSession(f.b.id).id;
  const first = await f.host.startRun({ sessionId: id, text: "hold" });
  const image = await f.host.importImage(
    id,
    "queue.png",
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  );
  const queued = await f.host.submitInput({ sessionId: id, text: "with image", attachments: [image.id] });
  expect(f.host.getSessionSnapshot(b).view.queue?.items).toHaveLength(0);
  await f.host.abortRun({ sessionId: id, runId: first.runId });
  await expect.poll(() => f.host.getSessionSnapshot(id).view.queue?.autoDrain).toBe(false);
  await f.host.close();
  const restart = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined, []);
  await restart.init();
  cleanup.push(() => restart.close());
  expect(restart.getSessionSnapshot(id).view.queue?.items[0]).toMatchObject({
    text: "with image",
    attachments: [image],
  });
  expect((await restart.readAttachment(id, image.id)).data).toBeTruthy();
  expect(restart.activeRuns.size).toBe(0);
  if (!("queueItemId" in queued)) throw new Error("queue ACK");
  await restart.inputQueue.resume(id);
  await expect.poll(() => restart.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
  await restart.submitInput({ sessionId: id, text: "error" });
  await restart.submitInput({ sessionId: id, text: "after error" });
  errorGate.resolve();
  await expect.poll(() => restart.getSessionSnapshot(id).view.queue?.pauseReason).toBe("error");
  expect(restart.getSessionSnapshot(id).view.queue?.items[0]?.text).toBe("after error");
  expect(await restart.submitInput({ sessionId: id, text: "new" })).toEqual({ confirmationRequired: true });
  await restart.submitInput({ sessionId: id, text: "new" }, "keep");
  await expect.poll(() => restart.getSessionSnapshot(id).view.runs.at(-1)?.userMessage).toBe("after error");
  await expect.poll(() => restart.activeRuns.size).toBe(0);
});

it("withdrawing queued quoted input restores editable text and reference cards", async () => {
  const release = deferred();
  const f = await fixture(async (_body, response) => {
    await release.promise;
    if (!response.destroyed) done(response);
  });
  const id = f.host.createSession(f.a.id).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  const selections = [{ text: "const result = 1;", path: join(f.dir, "example.ts") }];
  const text = buildSelectionPrompt("解释一下", selections);
  const queued = await f.host.submitInput({ sessionId: id, text });
  if (!("queueItemId" in queued) || !queued.queueItemId) throw new Error("queue ACK");
  const edited = await f.host.editQueuedInput(id, queued.queueItemId);
  expect(edited.item.text).toBe(text);
  expect(edited.draft).toMatchObject({ text: "解释一下", selections, selection: [4, 4] });
  expect(buildSelectionPrompt(edited.draft.text, edited.draft.selections ?? [])).toBe(text);
  expect(f.host.getSessionSnapshot(id).view.queue?.items).toHaveLength(0);
  f.host.saveDraft(id, {
    ...edited.draft,
    text: "",
    selections: [],
    selection: [0, 0],
    revision: edited.draft.revision + 1,
  });
  const excessive = buildSelectionPrompt(
    "手写引用块",
    Array.from({ length: 9 }, () => ({ text: "quote" })),
  );
  const next = await f.host.submitInput({ sessionId: id, text: excessive });
  if (!("queueItemId" in next) || !next.queueItemId) throw new Error("queue ACK");
  const fallback = await f.host.editQueuedInput(id, next.queueItemId);
  expect(fallback.draft.text).toBe(excessive);
  expect(fallback.draft.selections).toEqual([]);
  release.resolve();
});
