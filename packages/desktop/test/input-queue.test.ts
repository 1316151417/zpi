import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { buildSelectionPrompt } from "zpi-ui/selections";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionInputQueue } from "../src/main/input-queue.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

it("does not resurrect an accepted recovery item after asynchronous input preparation", async () => {
  const preparing = deferred(),
    release = deferred();
  const prepared = {
    text: "next",
    attachments: [],
    fileReferences: [],
    selection: { provider: "p", modelId: "m", reasoning: "off" },
  };
  const queue = new SessionInputQueue({
    check() {},
    running: () => true,
    prepare: async () => {
      preparing.resolve();
      await release.promise;
      return prepared;
    },
    retain: async () => {},
    discard: async () => {},
    withdraw: async () => {},
    start: async () => ({ runId: "run" }),
    save: vi.fn(),
    publish: vi.fn(),
  });
  queue.restore("session", { items: [{ ...prepared, id: "recovery", state: "queued" }], autoDrain: false });
  const pending = queue.submit({ sessionId: "session", text: "next" });
  await preparing.promise;
  queue.restore("session", { items: [], autoDrain: true });
  release.resolve();
  await pending;
  expect(queue.get("session").items.map((item) => item.text)).toEqual(["next"]);
  expect(queue.get("session").autoDrain).toBe(true);
});

it("queued inputs reorder, withdraw, guide and drain once without entering history early", async () => {
  const release = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: `${user} reply` }));
    if (user === "hold") await release.promise;
    if (!response.destroyed) done(response);
  });
  const session = await f.host.createSession(f.a.id),
    id = session.id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  const one = await f.host.submitInput({ sessionId: id, text: "one" });
  const two = await f.host.submitInput({ sessionId: id, text: "two" });
  const three = await f.host.submitInput({ sessionId: id, text: "three", fileReferences: ["missing"] });
  expect(f.host.getSessionSnapshot(id).view.runs.map((r) => r.userMessage)).toEqual(["hold"]);
  await expect(
    f.host.submitInput({ sessionId: id, text: "invalid", fileReferences: [""] }),
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
  expect(f.host.getSessionSnapshot(id).view.runs[0].status).toBe("running");
  expect(f.host.inputQueue.get(id).items.find((item) => item.id === three.queueItemId)?.state).toBe(
    "dispatching",
  );
  release.resolve();
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs.map((r) => [r.userMessage, r.status]))
    .toEqual([
      ["hold", "completed"],
      ["one revised", "completed"],
    ]);
  expect(f.host.getSessionSnapshot(id).view.queue?.items).toHaveLength(0);
  expect(f.host.getSessionSnapshot(id).view.runs[0].guides).toEqual([
    expect.objectContaining({ id: three.queueItemId, text: "three", fileReferences: ["missing"] }),
  ]);
  expect(f.server.requests).toHaveLength(3);
  release.resolve();
});

it("immediate drafts guide the current run without interrupting and preserve other queued inputs", async () => {
  const release = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((message) => message.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "reply" }));
    if (user === "hold") await release.promise;
    if (user !== "immediate" && !response.destroyed) done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  for (const text of ["queued first", "queued second"]) await f.host.submitInput({ sessionId: id, text });
  const queued = f.host.inputQueue.get(id).items;
  await expect(
    f.host.submitInput({ sessionId: id, text: "invalid", fileReferences: [""] }, undefined, true),
  ).rejects.toThrow();
  expect(f.host.inputQueue.get(id).items).toEqual(queued);
  const sent = await f.host.submitInput({ sessionId: id, text: "immediate" }, undefined, true);
  expect("queueItemId" in sent).toBe(true);
  expect(f.host.getSessionSnapshot(id).view.runs.map((run) => [run.userMessage, run.status])).toEqual([
    ["hold", "running"],
  ]);
  release.resolve();
  await expect.poll(() => f.server.requests.length).toBe(2);
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs[0].guides?.map((guide) => guide.text))
    .toEqual(["immediate"]);
  expect(f.host.inputQueue.get(id).items).toEqual(queued);
  const active = f.host.activeRuns.get(id);
  if (!active) throw new Error("missing guided run");
  await f.host.abortRun({ sessionId: id, runId: active.runId });
  await expect.poll(() => f.host.inputQueue.get(id).autoDrain).toBe(false);
  await f.host.submitInput({ sessionId: id, text: "direct paused" }, undefined, true);
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs.map((run) => [run.userMessage, run.status]))
    .toEqual([
      ["hold", "aborted"],
      ["direct paused", "completed"],
      ["queued first", "completed"],
      ["queued second", "completed"],
    ]);
  expect(f.host.inputQueue.get(id).items).toHaveLength(0);
  expect(f.server.requests).toHaveLength(5);
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
  const id = (await f.host.createSession(f.a.id)).id;
  const b = (await f.host.createSession(f.b.id)).id;
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
  const restart = new SessionHost(f.dir, f.settings, join(f.dir, "agent"), undefined, undefined);
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
  const id = (await f.host.createSession(f.a.id)).id;
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

it("preserves truncated text and pauses queued input instead of completing the run", async () => {
  const release = deferred();
  const f = await fixture(async (_, response) => {
    send(response, chunk({ content: "partial answer" }));
    await release.promise;
    done(response, "length");
  });
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "first" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  await f.host.submitInput({ sessionId: id, text: "queued follow-up" });
  const run = f.host.activeRuns.get(id);
  release.resolve();
  await run?.done;
  const view = f.host.getSessionSnapshot(id).view;
  expect(view.runs.at(-1)).toMatchObject({ status: "error", error: expect.stringContaining("截断") });
  expect(JSON.stringify(view.runs.at(-1))).toContain("partial answer");
  await expect
    .poll(() => f.host.inputQueue.get(id))
    .toMatchObject({ autoDrain: false, items: [{ text: "queued follow-up" }] });
  expect(f.server.requests).toHaveLength(1);
});

it.each([false, true])(
  "does not requeue accepted input when saving the optional title job fails (queued: %s)",
  async (queued) => {
    const f = await fixture((_, response) => {
      send(response, chunk({ content: "answer" }));
      done(response);
    });
    const id = (await f.host.createSession(f.a.id)).id;
    const itemId = "restored-first-input";
    if (queued)
      f.host.inputQueue.restore(id, {
        items: [
          {
            id: itemId,
            state: "queued",
            text: "restored request",
            fileReferences: [],
            attachments: [],
            selection: { provider: "custom", modelId: "fake", reasoning: "none" },
          },
        ],
        autoDrain: false,
      });
    let failed = false;
    const upsertTask = f.settings.state.upsertTask.bind(f.settings.state);
    const save = vi.spyOn(f.settings.state, "upsertTask").mockImplementation((input) => {
      if (!failed && input.titleState === "pending") {
        failed = true;
        throw new Error("temporary title state write failure");
      }
      return upsertTask(input);
    });
    let rejection: unknown;
    try {
      const sendInput = queued
        ? f.host.inputQueue.resume(id)
        : f.host.submitInput({ sessionId: id, text: "restored request" });
      await sendInput.catch((error) => {
        rejection = error;
      });
      expect(failed).toBe(true);
      expect(f.host.inputQueue.get(id).items).toEqual([]);
      expect(f.settings.state.getQueue(id)?.items ?? []).toEqual([]);
      expect(rejection).toBeUndefined();
      await expect.poll(() => f.host.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
      expect(f.host.getSessionSnapshot(id).view.runs.map((run) => run.userMessage)).toEqual([
        "restored request",
      ]);
      expect(f.server.requests).toHaveLength(1);
      expect(f.server.titleRequests).toHaveLength(0);
      expect(await readFile(join(f.dir, "agent", "logs", "error.log"), "utf8")).toContain(
        "temporary title state write failure",
      );
    } finally {
      save.mockRestore();
    }
  },
);

it("keeps unconsumed guides across stop/restart and sends them once on explicit resume", async () => {
  const gate = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((message) => message.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "reply" }));
    if (user === "hold") await gate.promise;
    if (!response.destroyed) done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  const guide = await f.host.submitInput({ sessionId: id, text: "retain me" }, undefined, true);
  if (!("queueItemId" in guide)) throw new Error("missing guide receipt");
  const run = f.host.activeRuns.get(id);
  if (!run) throw new Error("missing run");
  await f.host.abortRun({ sessionId: id, runId: run.runId });
  await expect.poll(() => f.host.inputQueue.get(id).items[0]?.state).toBe("queued");
  await f.host.close();
  const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => host.close());
  await host.init();
  expect(host.inputQueue.get(id).items.map((item) => item.id)).toEqual([guide.queueItemId]);
  await host.inputQueue.resume(id);
  await expect.poll(() => host.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
  expect(host.inputQueue.get(id).items).toHaveLength(0);
  expect(f.server.requests).toHaveLength(2);
  gate.resolve();
});

it("reconciles a consumed guide from the transcript if queue removal was not saved before restart", async () => {
  const gate = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((message) => message.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "reply" }));
    if (user === "hold") await gate.promise;
    if (!response.destroyed) done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  await f.host.submitInput({ sessionId: id, text: "consume once" }, undefined, true);
  const saved = structuredClone(f.host.inputQueue.get(id));
  expect(saved.items[0].state).toBe("dispatching");
  gate.resolve();
  await expect.poll(() => f.host.getSessionSnapshot(id).view.runs[0].status).toBe("completed");
  expect(f.host.getSessionSnapshot(id).view.runs[0].guides).toHaveLength(1);
  await f.host.close();
  // Simulate the last queue transaction being lost while the authoritative message survives.
  f.settings.state.setQueue(id, saved);
  const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => host.close());
  await host.init();
  expect(host.inputQueue.get(id).items).toHaveLength(0);
  await host.inputQueue.resume(id);
  expect(f.server.requests).toHaveLength(2);
  expect(host.getSessionSnapshot(id).view.runs[0].guides).toHaveLength(1);
});

it("returns the durable receipt if saving the guide handoff fails, so the draft is not resent", async () => {
  let fail = true;
  const guide = vi.fn(async () => true);
  const queue = new SessionInputQueue({
    check() {},
    running: () => true,
    prepare: async () => ({
      text: "guide",
      attachments: [],
      fileReferences: [],
      selection: { provider: "p", modelId: "m", reasoning: "none" },
    }),
    retain: async () => {},
    discard: async () => {},
    withdraw: async () => {},
    start: vi.fn(),
    guide,
    save: (_id, value) => {
      if (fail && value.items.some((item) => item.state === "dispatching")) {
        fail = false;
        throw new Error("handoff save failure");
      }
    },
    publish() {},
  });
  const receipt = await queue.submit({ sessionId: "s", text: "guide" }, undefined, true);
  if (!("queueItemId" in receipt) || !receipt.queueItemId) throw new Error("missing durable receipt");
  expect(queue.get("s").items.map((item) => item.id)).toEqual([receipt.queueItemId]);
  expect(queue.get("s").items[0].state).toBe("queued");
  expect(queue.get("s").autoDrain).toBe(false);
  expect(guide).not.toHaveBeenCalled();
  await queue.sendNow("s", receipt.queueItemId);
  expect(guide).toHaveBeenCalledOnce();
});

it("never dispatches a consumed guide twice when saving its acknowledgement fails", async () => {
  const start = vi.fn(async () => ({ runId: "new-run" }));
  let running = true;
  let rejectAcknowledgement = false;
  const queue = new SessionInputQueue({
    check() {},
    running: () => running,
    prepare: async () => ({
      text: "guide",
      attachments: [],
      fileReferences: [],
      selection: { provider: "p", modelId: "m", reasoning: "none" },
    }),
    retain: async () => {},
    discard: async () => {},
    withdraw: async () => {},
    start,
    guide: async () => true,
    save: (_id, value) => {
      if (rejectAcknowledgement && value.items.length === 0) {
        rejectAcknowledgement = false;
        throw new Error("ack save failure");
      }
    },
    publish() {},
  });
  const receipt = await queue.submit({ sessionId: "s", text: "guide" }, undefined, true);
  if (!("queueItemId" in receipt) || !receipt.queueItemId) throw new Error("missing guide receipt");
  rejectAcknowledgement = true;
  expect(() => queue.acknowledgeGuide("s", receipt.queueItemId)).toThrow("ack save failure");
  expect(queue.get("s").items).toHaveLength(0);
  running = false;
  queue.settled("s", "completed");
  await queue.resume("s");
  expect(start).not.toHaveBeenCalled();
});

it("sends a guide once on the next run if the active run settles during preparation", async () => {
  const preparing = deferred(),
    release = deferred();
  let running = true;
  const start = vi.fn(async () => {
    running = true;
    return { runId: "fallback" };
  });
  const queue = new SessionInputQueue({
    check() {},
    running: () => running,
    prepare: async () => {
      preparing.resolve();
      await release.promise;
      return {
        text: "guide",
        attachments: [],
        fileReferences: [],
        selection: { provider: "p", modelId: "m", reasoning: "none" },
      };
    },
    retain: async () => {},
    discard: async () => {},
    withdraw: async () => {},
    start,
    guide: async () => false,
    save() {},
    publish() {},
  });
  const receipt = queue.submit({ sessionId: "s", text: "guide" }, undefined, true);
  await preparing.promise;
  running = false;
  queue.settled("s", "completed");
  release.resolve();
  await receipt;
  await queue.resume("s");
  expect(start).toHaveBeenCalledOnce();
  expect(queue.get("s").items).toHaveLength(0);
});

it("retains an image-only guide and its display metadata after consumption and restart", async () => {
  const gate = deferred();
  const f = await fixture(async (_body, response) => {
    send(response, chunk({ content: "reply" }));
    if (f.server.requests.length === 1) await gate.promise;
    if (!response.destroyed) done(response);
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
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  const image = await f.host.importImage(
    id,
    "guide.png",
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  );
  await f.host.submitInput({ sessionId: id, text: "", attachments: [image.id] }, undefined, true);
  gate.resolve();
  await expect.poll(() => f.host.getSessionSnapshot(id).view.runs[0].status).toBe("completed");
  expect(f.host.getSessionSnapshot(id).view.runs).toHaveLength(1);
  expect(f.host.getSessionSnapshot(id).view.runs[0].guides?.[0].attachments).toEqual([image]);
  const fork = await f.host.forkSession(id, f.host.getSessionSnapshot(id).view.runs[0].runId);
  expect(f.host.getSessionSnapshot(fork.id).view.runs[0].guides?.[0].attachments).toEqual([image]);
  expect((await f.host.readAttachment(fork.id, image.id)).data).toBeTruthy();
  await f.host.close();
  // Crash after durable consumption/queue acknowledgement but before attachment markers settle.
  const metadataPath = join(f.dir, "agent", "attachments", id, "index.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as {
    id: string;
    used: boolean;
    queued?: boolean;
  }[];
  await writeFile(
    metadataPath,
    JSON.stringify(
      metadata.map((item) => (item.id === image.id ? { ...item, used: false, queued: true } : item)),
    ),
  );
  const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
  cleanup.push(() => host.close());
  await host.init();
  expect(host.getSessionSnapshot(id).view.runs[0].guides?.[0].attachments).toEqual([image]);
  expect((await host.readAttachment(id, image.id)).data).toBeTruthy();
  const recovered = JSON.parse(await readFile(metadataPath, "utf8")) as {
    id: string;
    used: boolean;
    queued?: boolean;
  }[];
  expect(recovered.find((item) => item.id === image.id)).toMatchObject({ used: true, queued: false });
  expect(host.inputQueue.get(id).items).toHaveLength(0);
});

it("acknowledges a persisted input even if publishing its queue update fails", async () => {
  const report = vi.fn();
  const queue = new SessionInputQueue({
    check() {},
    running: () => true,
    prepare: async () => ({
      text: "guide",
      attachments: [],
      fileReferences: [],
      selection: { provider: "p", modelId: "m", reasoning: "none" },
    }),
    retain: async () => {},
    discard: async () => {},
    withdraw: async () => {},
    start: vi.fn(),
    guide: async () => true,
    save() {},
    publish() {
      throw new Error("renderer publication failed");
    },
    report,
  });
  const receipt = await queue.submit({ sessionId: "s", text: "guide" }, undefined, true);
  if (!("queueItemId" in receipt) || !receipt.queueItemId) throw new Error("missing receipt");
  expect(queue.get("s").items.map((item) => item.id)).toEqual([receipt.queueItemId]);
  queue.acknowledgeGuide("s", receipt.queueItemId);
  expect(queue.get("s").items).toHaveLength(0);
  expect(report).toHaveBeenCalled();
});

it("cleans an attachment when an unconsumed guide is stopped and removed", async () => {
  const gate = deferred();
  const f = await fixture(async (_body, response) => {
    send(response, chunk({ content: "waiting" }));
    await gate.promise;
    if (!response.destroyed) done(response);
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
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  const image = await f.host.importImage(
    id,
    "unused-guide.png",
    await sharp({ create: { width: 2, height: 2, channels: 3, background: "white" } })
      .png()
      .toBuffer(),
  );
  const receipt = await f.host.submitInput(
    { sessionId: id, text: "guide", attachments: [image.id] },
    undefined,
    true,
  );
  if (!("queueItemId" in receipt) || !receipt.queueItemId) throw new Error("missing receipt");
  const run = f.host.activeRuns.get(id);
  if (!run) throw new Error("missing run");
  await f.host.abortRun({ sessionId: id, runId: run.runId });
  await expect.poll(() => f.host.inputQueue.get(id).items[0]?.state).toBe("queued");
  await f.host.inputQueue.remove(id, receipt.queueItemId);
  await expect(f.host.readAttachment(id, image.id)).rejects.toThrow();
  gate.resolve();
});

it.each([true, false])(
  "keeps a successful run receipt if subsequent queue housekeeping fails (immediate=%s)",
  async (immediate) => {
    const start = vi.fn(async () => ({ runId: "accepted" }));
    let failures = 1;
    const queue = new SessionInputQueue({
      check() {},
      running: () => false,
      prepare: async () => ({
        text: "new",
        attachments: [],
        fileReferences: [],
        selection: { provider: "p", modelId: "m", reasoning: "none" },
      }),
      retain: async () => {},
      discard: async () => {},
      withdraw: async () => {},
      start,
      save: () => {
        if (failures-- > 0) throw new Error("housekeeping failure");
      },
      publish() {},
    });
    queue.restore("s", {
      items: [
        {
          id: "old",
          text: "older queued input",
          attachments: [],
          fileReferences: [],
          selection: { provider: "p", modelId: "m", reasoning: "none" },
          state: "queued",
        },
      ],
      autoDrain: false,
    });
    await expect(queue.submit({ sessionId: "s", text: "new" }, "keep", immediate)).resolves.toEqual({
      runId: "accepted",
    });
    expect(start).toHaveBeenCalledOnce();
    expect(queue.get("s").items.map((item) => item.id)).toEqual(["old"]);
    expect(queue.get("s").autoDrain).toBe(false);
    expect(queue.get("s").error).toContain("housekeeping failure");
  },
);
