import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { buildSelectionPrompt } from "@zpi-dev/ui/selections";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { chunk, deferred, done, send } from "../../../tests/fake-server.ts";
import { SessionInputQueue } from "../src/main/input-queue.ts";
import { SessionHost } from "../src/main/session-host.ts";
import { cleanup, fixture } from "./helpers/host-fixture.ts";

function queueRuntime(overrides: Partial<ConstructorParameters<typeof SessionInputQueue>[0]> = {}) {
  return {
    check() {},
    running: () => false,
    prepare: async (input: { text: string }) => ({
      text: input.text,
      attachments: [],
      fileReferences: [],
      selection: { provider: "p", modelId: "m", reasoning: "none" },
    }),
    retain: async () => {},
    discard: async () => {},
    start: vi.fn(async () => ({ runId: "accepted" })),
    stop: vi.fn(async () => {}),
    save: vi.fn(),
    publish: vi.fn(),
    ...overrides,
  };
}

it.each(["reserve", "stop", "start", "after-accept"] as const)(
  "keeps queued input recoverable without duplicate delivery when immediate sending fails at %s",
  async (stage) => {
    let fail = true,
      accepted = false;
    const item = (id: string) => ({
      id,
      text: id,
      attachments: [],
      fileReferences: [],
      selection: { provider: "p", modelId: "m", reasoning: "none" },
      state: "queued" as const,
    });
    const runtime = queueRuntime({
      stop: vi.fn(async () => {
        if (fail && stage === "stop") throw new Error(stage);
        queue.settled("s", "aborted");
      }),
      start: vi.fn(async () => {
        if (fail && stage === "start") throw new Error(stage);
        accepted = true;
        if (fail && stage === "after-accept") throw new Error(stage);
        return { runId: "accepted" };
      }),
      accepted: () => accepted,
      save: (_id, value) => {
        if (fail && stage === "reserve" && value.items.some((entry) => entry.state === "dispatching"))
          throw new Error(stage);
      },
    });
    const queue = new SessionInputQueue(runtime);
    queue.restore("s", { items: [item("target"), item("later")], autoDrain: false });
    await expect(queue.sendNow("s", "target")).rejects.toThrow(stage);
    expect(queue.get("s").items.map((entry) => entry.id)).toEqual(
      stage === "after-accept" ? ["later"] : ["target", "later"],
    );
    expect(queue.get("s").items.every((entry) => entry.state === "queued")).toBe(true);
    if (stage === "reserve") expect(runtime.stop).not.toHaveBeenCalled();
    if (stage !== "after-accept") {
      fail = false;
      await queue.sendNow("s", "target");
      expect(queue.get("s").items.map((entry) => entry.id)).toEqual(["later"]);
    } else {
      await expect(queue.sendNow("s", "target")).rejects.toThrow("不存在");
      expect(runtime.start).toHaveBeenCalledOnce();
    }
  },
);

it("restores legacy mistaken guide items as paused queue entries and never resends accepted IDs", async () => {
  const runtime = queueRuntime();
  const queue = new SessionInputQueue(runtime);
  const item = {
    text: "legacy input",
    attachments: [],
    fileReferences: [],
    selection: { provider: "p", modelId: "m", reasoning: "none" },
    state: "dispatching" as const,
    delivery: "guide" as const,
  };
  queue.restore(
    "s",
    {
      items: [
        { ...item, id: "accepted" },
        { ...item, id: "pending" },
      ],
      autoDrain: true,
    },
    new Set(["accepted"]),
  );
  expect(queue.get("s")).toMatchObject({ autoDrain: false, items: [{ id: "pending", state: "queued" }] });
  expect(queue.get("s").items[0].delivery).toBeUndefined();
  await queue.resume("s");
  expect(runtime.start).toHaveBeenCalledOnce();
  expect(queue.get("s").items).toHaveLength(0);
});

it("preserves accepted receipts when queue publication fails", async () => {
  const runtime = queueRuntime({
    running: () => true,
    publish: () => {
      throw new Error("notification failed");
    },
    report: vi.fn(),
  });
  const queue = new SessionInputQueue(runtime);
  const receipt = await queue.submit({ sessionId: "s", text: "input" });
  if (!("queueItemId" in receipt) || !receipt.queueItemId) throw new Error("missing receipt");
  await queue.remove("s", receipt.queueItemId);
  expect(queue.get("s").items).toHaveLength(0);
  expect(runtime.report).toHaveBeenCalled();
});

it("recovers old pending guides without resending a guide already durable in history", async () => {
  const gate = deferred();
  const f = await fixture(async (_body, response, index) => {
    send(response, chunk({ content: "answer" }));
    if (index === 0) await gate.promise;
    if (!response.destroyed) done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  try {
    await f.host.submitInput({ sessionId: id, text: "hold" });
    await expect.poll(() => f.server.requests.length).toBe(1);
    const run = f.host.activeRuns.get(id);
    expect(
      run?.session?.steer("accepted guide", {
        inputId: "accepted-guide",
        userGuide: { text: "accepted guide", attachments: [], fileReferences: [] },
      }),
    ).toBe(true);
    gate.resolve();
    await expect.poll(() => f.host.getSessionSnapshot(id).view.runs[0]?.status).toBe("completed");
    expect(f.server.requests).toHaveLength(2);
    expect(f.settings.state.acceptedInputIds(id).has("accepted-guide")).toBe(false);
    await f.host.close();
    // Reproduce an old crash after guide append but before queue acknowledgement.
    f.settings.state.setQueue(id, {
      items: ["accepted-guide", "pending-guide"].map((itemId) => ({
        id: itemId,
        text: itemId === "accepted-guide" ? "accepted guide" : "pending guide",
        state: "dispatching",
        delivery: "guide",
        fileReferences: [],
        attachments: [],
        selection: { provider: "custom", modelId: "fake", reasoning: "none" },
      })),
      autoDrain: true,
    });
    const host = new SessionHost(f.dir, f.settings, join(f.dir, "agent"));
    cleanup.push(() => host.close());
    await host.init();
    expect(host.getSessionSnapshot(id).view.runs[0].guides).toMatchObject([
      { id: "accepted-guide", text: "accepted guide" },
    ]);
    expect(host.inputQueue.get(id)).toMatchObject({
      autoDrain: false,
      items: [{ id: "pending-guide", state: "queued" }],
    });
    expect(host.inputQueue.get(id).items[0].delivery).toBeUndefined();
    expect(f.server.requests).toHaveLength(2);
    await host.inputQueue.sendNow(id, "pending-guide");
    await expect.poll(() => host.getSessionSnapshot(id).view.runs.at(-1)?.status).toBe("completed");
    expect(host.inputQueue.get(id).items).toHaveLength(0);
    expect(host.getSessionSnapshot(id).view.runs.map((run) => run.userMessage)).toEqual([
      "hold",
      "pending guide",
    ]);
    expect(f.server.requests).toHaveLength(3);
  } finally {
    gate.resolve();
  }
});

it("preempts a quiet model request while preserving completed tools without replay", async () => {
  const release = deferred();
  const f = await fixture(async (body, response) => {
    const messages = body.messages as { role: string; content: string }[];
    const user = messages.filter((m) => m.role === "user").at(-1)?.content;
    if (user === "hold" && !messages.some((m) => m.role === "tool")) {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "write-once",
              type: "function",
              function: { name: "bash", arguments: JSON.stringify({ command: "printf x >> once.txt" }) },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else if (user === "hold") {
      response.flushHeaders();
      await release.promise;
      if (!response.destroyed) done(response);
    } else {
      send(response, chunk({ content: "replacement" }));
      done(response);
    }
  });
  const id = (await f.host.createSession(f.a.id)).id;
  try {
    await f.host.submitInput({ sessionId: id, text: "hold" });
    await expect.poll(() => f.server.requests.length).toBe(2);
    await f.host.submitInput({ sessionId: id, text: "replacement" }, undefined, true);
    await expect
      .poll(() => f.host.getSessionSnapshot(id).view.runs.at(-1))
      .toMatchObject({ userMessage: "replacement", status: "completed" });
    expect(f.host.getSessionSnapshot(id).view.runs[0].status).toBe("aborted");
    expect(await readFile(join(f.dir, "a", "once.txt"), "utf8")).toBe("x");
    expect(f.server.requests).toHaveLength(3);
    expect(
      (f.server.requests[2].messages as unknown as { role: string }[]).filter((m) => m.role === "tool"),
    ).toHaveLength(1);
  } finally {
    release.resolve();
  }
});

it("immediate input cancels an active tool and waits for its run to release ownership", async () => {
  const f = await fixture((body, response) => {
    const user = (body.messages as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    if (user === "hold tool") {
      send(
        response,
        chunk({
          tool_calls: [
            {
              index: 0,
              id: "long-tool",
              type: "function",
              function: {
                name: "bash",
                arguments: JSON.stringify({
                  command: "printf ready > ready.txt; sleep 30; printf unexpected > late.txt",
                }),
              },
            },
          ],
        }),
      );
      done(response, "tool_calls");
    } else {
      send(response, chunk({ content: "replacement" }));
      done(response);
    }
  });
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold tool" });
  await expect
    .poll(async () => readFile(join(f.dir, "a", "ready.txt"), "utf8").catch(() => ""))
    .toBe("ready");
  await f.host.submitInput({ sessionId: id, text: "replacement" }, undefined, true);
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs.at(-1))
    .toMatchObject({ userMessage: "replacement", status: "completed" });
  expect(f.host.getSessionSnapshot(id).view.runs[0].status).toBe("aborted");
  await expect(readFile(join(f.dir, "a", "late.txt"))).rejects.toThrow();
  expect(f.server.requests).toHaveLength(2);
});

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
    start: async () => ({ runId: "run" }),
    stop: async () => {},
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
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs.map((r) => [r.userMessage, r.status]))
    .toEqual([
      ["hold", "aborted"],
      ["three", "completed"],
      ["one revised", "completed"],
    ]);
  expect(f.host.getSessionSnapshot(id).view.queue?.items).toHaveLength(0);
  expect(f.host.getSessionSnapshot(id).view.runs[1].fileReferences).toEqual(["missing"]);
  expect(f.server.requests).toHaveLength(3);
  release.resolve();
});

it("immediate drafts validate before stopping, bypass queued inputs, and resume a held queue", async () => {
  const f = await fixture(async (body, response) => {
    const user = (body.messages as unknown as { role: string; content: string }[])
      .filter((message) => message.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "reply" }));
    if (user !== "hold" && user !== "immediate") done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  await f.host.submitInput({ sessionId: id, text: "hold" });
  await expect.poll(() => f.server.requests.length).toBe(1);
  for (const text of ["queued first", "queued second"]) await f.host.submitInput({ sessionId: id, text });
  const queued = f.host.inputQueue.get(id).items;
  await expect(
    f.host.submitInput({ sessionId: id, text: "invalid", fileReferences: [""] }, undefined, true),
  ).rejects.toThrow();
  expect(f.host.getSessionSnapshot(id).view.runs[0].status).toBe("running");
  expect(f.host.inputQueue.get(id).items).toEqual(queued);
  await f.host.submitInput({ sessionId: id, text: "immediate" }, undefined, true);
  await expect.poll(() => f.server.requests.length).toBe(2);
  expect(f.host.getSessionSnapshot(id).view.runs.map((run) => [run.userMessage, run.status])).toEqual([
    ["hold", "aborted"],
    ["immediate", "running"],
  ]);
  expect(f.host.inputQueue.get(id).items).toEqual(queued);
  const active = f.host.activeRuns.get(id);
  if (!active) throw new Error("missing immediate run");
  await f.host.abortRun({ sessionId: id, runId: active.runId });
  await expect.poll(() => f.host.inputQueue.get(id).autoDrain).toBe(false);
  await f.host.submitInput({ sessionId: id, text: "direct paused" }, undefined, true);
  await expect
    .poll(() => f.host.getSessionSnapshot(id).view.runs.map((run) => [run.userMessage, run.status]))
    .toEqual([
      ["hold", "aborted"],
      ["immediate", "aborted"],
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
  f.settings.saveProvider({
    id: "custom",
    name: "Custom",
    baseUrl: f.server.url,
    models: [
      {
        id: "fake",
        input: ["text", "image"],
        reasoning: true,
        contextWindow: 32768,
        maxTokens: 4096,
        compat: { supportsReasoningEffort: true },
      },
    ],
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

it("rolls back draft and queue changes if editing a queued input cannot be persisted", async () => {
  const gate = deferred();
  const f = await fixture(async (body, response) => {
    const user = (body.messages as { role: string; content: string }[])
      .filter((m) => m.role === "user")
      .at(-1)?.content;
    send(response, chunk({ content: "answer" }));
    if (user === "hold") await gate.promise;
    if (!response.destroyed) done(response);
  });
  const id = (await f.host.createSession(f.a.id)).id;
  try {
    await f.host.submitInput({ sessionId: id, text: "hold" });
    await expect.poll(() => f.server.requests.length).toBe(1);
    const receipt = await f.host.submitInput({ sessionId: id, text: "keep this input" });
    if (!("queueItemId" in receipt) || !receipt.queueItemId) throw new Error("missing queue receipt");
    vi.spyOn(f.settings.state, "setQueue").mockImplementationOnce(() => {
      throw new Error("retract save failed");
    });
    await expect(f.host.editQueuedInput(id, receipt.queueItemId)).rejects.toThrow("retract save failed");
    expect(f.host.drafts.get(id).text).toBe("");
    expect(f.host.inputQueue.get(id).items.map((item) => item.id)).toEqual([receipt.queueItemId]);
    gate.resolve();
    await expect
      .poll(() => f.host.getSessionSnapshot(id).view.runs.at(-1))
      .toMatchObject({
        userMessage: "keep this input",
        status: "completed",
      });
    expect(f.server.requests).toHaveLength(2);
  } finally {
    gate.resolve();
  }
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
      start,
      stop: async () => {},
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
