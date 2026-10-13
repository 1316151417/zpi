import { expect, it, vi } from "vitest";
import type { InputQueue } from "zpi-ui";
import { deferred } from "../../../tests/fake-server.ts";
import { SessionInputQueue } from "../src/main/input-queue.ts";

it("a failed archive never persists an empty queue or discards accepted input", async () => {
  const runtime: ConstructorParameters<typeof SessionInputQueue>[0] = {
    check: () => {},
    running: () => false,
    prepare: vi.fn(),
    retain: vi.fn(),
    discard: vi.fn(),
    withdraw: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    save: vi.fn(),
    publish: vi.fn(),
  };
  const queue = new SessionInputQueue(runtime);
  const saved: InputQueue = {
    items: [
      {
        id: "item",
        state: "queued",
        text: "keep",
        attachments: [],
        fileReferences: [],
        selection: { provider: "p", modelId: "m", reasoning: "none" },
      },
    ],
    autoDrain: false,
  };
  queue.restore("session", saved);
  await expect(
    queue.archive("session", () => {
      throw new Error("archive failed");
    }),
  ).rejects.toThrow("archive failed");
  expect(queue.get("session").items).toEqual(saved.items);
  expect(runtime.save).not.toHaveBeenCalled();
  expect(runtime.discard).not.toHaveBeenCalled();
  runtime.save = vi.fn(() => {
    throw new Error("queue write failed");
  });
  const persist = vi.fn();
  await expect(queue.archive("session", persist)).rejects.toThrow("queue write failed");
  expect(persist).toHaveBeenCalledOnce();
  expect(queue.get("session").items).toEqual(saved.items);
  expect(runtime.discard).not.toHaveBeenCalled();
});

it("archive waits for process cleanup and prevents queued submissions from restarting the owner", async () => {
  let archived = false;
  const cleaning = deferred(),
    release = deferred();
  const runtime: ConstructorParameters<typeof SessionInputQueue>[0] = {
    check: () => {
      if (archived) throw new Error("archived");
    },
    running: () => false,
    prepare: vi.fn(),
    retain: vi.fn(),
    discard: vi.fn(),
    withdraw: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    save: vi.fn(),
    publish: vi.fn(),
  };
  const queue = new SessionInputQueue(runtime);
  const archive = queue.archive("owner", async () => {
    cleaning.resolve();
    await release.promise;
    archived = true;
  });
  await cleaning.promise;
  const submit = expect(queue.submit({ sessionId: "owner", text: "next" })).rejects.toThrow("archived");
  expect(runtime.save).not.toHaveBeenCalled();
  release.resolve();
  await archive;
  await submit;
  expect(runtime.save).toHaveBeenCalledOnce();
  expect(runtime.start).not.toHaveBeenCalled();
});
